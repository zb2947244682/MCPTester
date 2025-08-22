#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn, exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs/promises";
import { EventEmitter } from "events";

const execAsync = promisify(exec);

// 路径处理工具函数
/**
 * 标准化路径处理函数，支持多种路径格式
 * @param {string} inputPath - 输入的路径，支持以下格式：
 *   - Windows风格：D:\Path\To\File.js 或 "D:\Path\To\File.js"
 *   - Unix风格：/path/to/file.js 或 D:/Path/To/File.js
 *   - 带空格的路径："D:\My Path\File.js"
 *   - 相对路径：./file.js 或 ../folder/file.js
 *   - 带命令的路径：node D:\Path\script.js 或 "node" "D:\Path\script.js"
 * @returns {object} 返回 {executable, scriptPath, args} 对象
 */
function parseServerCommand(inputPath) {
  if (!inputPath) {
    throw new Error('路径不能为空');
  }

  // 去除首尾引号（如果有）
  let command = inputPath.trim();
  if ((command.startsWith('"') && command.endsWith('"')) || 
      (command.startsWith("'") && command.endsWith("'"))) {
    command = command.slice(1, -1);
  }

  // 将所有反斜杠转换为正斜杠，统一路径格式
  command = command.replace(/\\/g, '/');

  // 解析命令和参数
  // 支持格式："node path/to/script.js arg1 arg2" 或 "node" "path/to/script.js" "arg1"
  const parts = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '"' || char === "'") {
      inQuotes = !inQuotes;
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) {
    parts.push(current);
  }

  // 判断第一部分是否是可执行文件（node, python, deno等）
  const executableCommands = ['node', 'python', 'python3', 'deno', 'bun', 'tsx', 'ts-node'];
  let executable = 'node'; // 默认使用node
  let scriptPath = '';
  let args = [];

  if (parts.length === 0) {
    throw new Error('无效的命令格式');
  }

  // 检查第一部分是否是可执行命令
  const firstPart = parts[0].toLowerCase();
  if (executableCommands.includes(firstPart)) {
    executable = parts[0];
    scriptPath = parts[1] || '';
    args = parts.slice(2);
  } else {
    // 假设整个输入是脚本路径
    scriptPath = parts[0];
    args = parts.slice(1);
  }

  // 将路径恢复为系统原生格式（Windows下使用反斜杠）
  if (process.platform === 'win32' && scriptPath) {
    // 但保持正斜杠，因为Node.js在Windows上也支持正斜杠
    // scriptPath = scriptPath.replace(/\//g, '\\');
  }

  return {
    executable,
    scriptPath,
    args
  };
}

// MCP客户端类，用于真实的MCP通信
class MCPClient extends EventEmitter {
  constructor() {
    super();
    this.process = null;
    this.messageBuffer = '';
    this.pendingRequests = new Map();
    this.nextId = 1;
    this.initialized = false;
    this.tools = [];
    this.resources = [];
    this.prompts = [];
  }

  async connect(command, args = []) {
    return new Promise((resolve, reject) => {
      try {
        // 启动MCP服务器进程
        this.process = spawn(command, args, {
          stdio: 'pipe',
          shell: process.platform === 'win32'
        });

        // 处理stdout数据
        this.process.stdout.on('data', (data) => {
          this.messageBuffer += data.toString();
          this.processMessages();
        });

        // 处理stderr（调试信息）
        this.process.stderr.on('data', (data) => {
          console.log('[MCP Server Debug]:', data.toString());
        });

        // 处理进程错误
        this.process.on('error', (error) => {
          reject(new Error(`启动MCP服务器失败: ${error.message}`));
        });

        // 进程退出处理
        this.process.on('exit', (code, signal) => {
          if (code !== 0 && code !== null && signal !== 'SIGTERM') {
            console.log(`MCP服务器异常退出，退出码: ${code}, 信号: ${signal}`);
          }
        });

        // 延迟一下确保进程启动
        setTimeout(() => resolve(), 500);
      } catch (error) {
        reject(error);
      }
    });
  }

  processMessages() {
    const lines = this.messageBuffer.split('\n');
    this.messageBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim()) {
        try {
          const message = JSON.parse(line.trim());
          this.handleMessage(message);
        } catch (e) {
          // 忽略非JSON行
        }
      }
    }
  }

  handleMessage(message) {
    // 处理响应
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        if (message.error) {
          pending.reject(new Error(message.error.message || 'Unknown error'));
        } else {
          pending.resolve(message.result);
        }
        this.pendingRequests.delete(message.id);
      }
    }
    
    // 处理通知
    if (message.method && !message.id) {
      this.emit('notification', message);
    }
  }

  async sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params
      };

      this.pendingRequests.set(id, { resolve, reject });

      try {
        this.process.stdin.write(JSON.stringify(request) + '\n');
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }

      // 设置超时
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`请求超时: ${method}`));
        }
      }, 30000);
    });
  }

  async initialize() {
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-tester', version: '1.0.0' }
    });
    
    this.initialized = true;
    
    // 发送initialized通知
    try {
      this.process.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      }) + '\n');
    } catch (e) {
      // 忽略错误
    }
    
    return result;
  }

  async listTools() {
    const result = await this.sendRequest('tools/list');
    this.tools = result.tools || [];
    return this.tools;
  }

  async callTool(name, args = {}) {
    return await this.sendRequest('tools/call', {
      name,
      arguments: args
    });
  }

  async listResources() {
    try {
      const result = await this.sendRequest('resources/list');
      this.resources = result.resources || [];
      return this.resources;
    } catch (e) {
      // 服务器可能不支持resources
      return [];
    }
  }

  async listPrompts() {
    try {
      const result = await this.sendRequest('prompts/list');
      this.prompts = result.prompts || [];
      return this.prompts;
    } catch (e) {
      // 服务器可能不支持prompts
      return [];
    }
  }

  disconnect() {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.pendingRequests.clear();
  }
}

// 创建一个 MCP 服务器实例
const server = new McpServer({
  name: "mcp-tester",
  version: "1.0.0"
});

// 注册 test_mcp_server 工具
server.registerTool("test_mcp_server", {
  title: "Test MCP Server",
  description: "测试指定的MCP服务器，检查其工具列表和基本功能",
  inputSchema: {
    server_command: z.string().optional().describe("启动MCP服务器的命令，如：node path/to/server.js。如未指定，将使用TARGET_MCP_SERVER环境变量"),
    server_args: z.array(z.string()).default([]).describe("服务器启动参数"),
    timeout: z.number().default(30).describe("测试超时时间(秒)")
  }
}, async ({ server_command, server_args = [], timeout = 30 }) => {
  // 支持从环境变量读取默认的服务器命令
  const defaultServerCommand = process.env.TARGET_MCP_SERVER;
  const finalServerCommand = server_command || defaultServerCommand;
  
  if (!finalServerCommand) {
    throw new Error("请指定server_command参数或设置TARGET_MCP_SERVER环境变量");
  }

  // 使用统一的路径解析函数
  const parsedCommand = parseServerCommand(finalServerCommand);
  const { executable, scriptPath, args: parsedArgs } = parsedCommand;
  const allArgs = [scriptPath, ...parsedArgs, ...server_args];
  
  // 验证文件是否存在
  try {
    const fullPath = path.resolve(scriptPath);
    await fs.access(fullPath);
  } catch (error) {
    throw new Error(`找不到文件: ${scriptPath}\n请检查路径是否正确。\n原始输入: ${finalServerCommand}\n解析结果: 可执行文件=${executable}, 脚本路径=${scriptPath}`);
  }

  const client = new MCPClient();
  const startTime = Date.now();
  let testResults = {
    serverStartup: false,
    initialization: false,
    toolsListed: false,
    toolsCount: 0,
    tools: [],
    capabilities: {},
    errors: [],
    timings: {}
  };

  try {
    // 连接到MCP服务器
    await client.connect(executable, allArgs);
    testResults.serverStartup = true;
    testResults.timings.startup = Date.now() - startTime;

    // 初始化
    const initStartTime = Date.now();
    const initResult = await client.initialize();
    testResults.initialization = true;
    testResults.capabilities = initResult.capabilities || {};
    testResults.serverInfo = initResult.serverInfo || {};
    testResults.timings.initialization = Date.now() - initStartTime;

    // 获取工具列表
    const toolsStartTime = Date.now();
    const tools = await client.listTools();
    testResults.toolsListed = true;
    testResults.toolsCount = tools.length;
    testResults.tools = tools;
    testResults.timings.listTools = Date.now() - toolsStartTime;

    // 尝试获取资源和提示（如果支持）
    try {
      const resources = await client.listResources();
      testResults.resourcesCount = resources.length;
      testResults.resources = resources;
    } catch (e) {
      // 忽略，可能不支持
    }

    try {
      const prompts = await client.listPrompts();
      testResults.promptsCount = prompts.length;
      testResults.prompts = prompts;
    } catch (e) {
      // 忽略，可能不支持
    }

    // 测试第一个工具（如果有）
    if (tools.length > 0) {
      const firstTool = tools[0];
      const testArgs = generateExampleCall(firstTool);
      try {
        const toolStartTime = Date.now();
        const result = await client.callTool(firstTool.name, testArgs);
        testResults.sampleToolCall = {
          tool: firstTool.name,
          args: testArgs,
          success: true,
          response: result,
          executionTime: Date.now() - toolStartTime
        };
      } catch (e) {
        testResults.sampleToolCall = {
          tool: firstTool.name,
          args: testArgs,
          success: false,
          error: e.message
        };
      }
    }

    testResults.timings.total = Date.now() - startTime;

  } catch (error) {
    testResults.errors.push(error.message);
  } finally {
    client.disconnect();
  }

  // 生成测试报告
  const report = `# MCP服务器测试结果

## 📊 测试概览
- **服务器命令**: \`${finalServerCommand}\`
- **测试时间**: ${new Date().toISOString()}
- **总耗时**: ${testResults.timings.total || 0}ms

## ✅ 连接状态
- **服务器启动**: ${testResults.serverStartup ? '✅ 成功' : '❌ 失败'}
- **协议初始化**: ${testResults.initialization ? '✅ 成功' : '❌ 失败'}
- **工具列表获取**: ${testResults.toolsListed ? '✅ 成功' : '❌ 失败'}

## 🔧 服务器信息
${testResults.serverInfo ? `- **名称**: ${testResults.serverInfo.name || '未知'}
- **版本**: ${testResults.serverInfo.version || '未知'}` : '未提供服务器信息'}

## 📦 功能支持
- **工具数量**: ${testResults.toolsCount}
- **资源数量**: ${testResults.resourcesCount !== undefined ? testResults.resourcesCount : '不支持'}
- **提示数量**: ${testResults.promptsCount !== undefined ? testResults.promptsCount : '不支持'}

## 🛠️ 工具列表
${testResults.tools.length > 0 ? testResults.tools.map((tool, i) => 
  `${i + 1}. **${tool.name}**\n   - ${tool.description || '无描述'}`
).join('\n') : '未发现任何工具'}

## ⚡ 性能指标
- **启动时间**: ${testResults.timings.startup || 0}ms
- **初始化时间**: ${testResults.timings.initialization || 0}ms
- **工具列表获取**: ${testResults.timings.listTools || 0}ms

${testResults.sampleToolCall ? `## 🧪 工具测试示例
### 测试工具: ${testResults.sampleToolCall.tool}
- **测试结果**: ${testResults.sampleToolCall.success ? '✅ 成功' : '❌ 失败'}
${testResults.sampleToolCall.executionTime ? `- **执行时间**: ${testResults.sampleToolCall.executionTime}ms` : ''}
${testResults.sampleToolCall.error ? `- **错误信息**: ${testResults.sampleToolCall.error}` : ''}

#### 请求参数:
\`\`\`json
${JSON.stringify(testResults.sampleToolCall.args, null, 2)}
\`\`\`

${testResults.sampleToolCall.response ? `#### 响应结果:
\`\`\`json
${JSON.stringify(testResults.sampleToolCall.response, null, 2)}
\`\`\`` : ''}` : ''}

${testResults.errors.length > 0 ? `## ⚠️ 错误信息
${testResults.errors.map(e => `- ${e}`).join('\n')}` : ''}`;

  return {
    content: [
      {
        type: "text",
        text: report,
      },
    ],
  };
});

// 注册 call_mcp_tool 工具
server.registerTool("call_mcp_tool", {
  title: "Call MCP Tool",
  description: "直接调用MCP工具并返回结果，不生成报告。适用于快速测试单个工具功能。",
  inputSchema: {
    server_command: z.string().describe("MCP服务器启动命令。支持多种格式：\n- Windows路径：D:\\Path\\To\\script.js 或 D:/Path/To/script.js\n- 带引号路径：\"D:\\My Path\\script.js\"\n- 带执行器：node D:\\Path\\script.js\n- 相对路径：./script.js 或 ../folder/script.js"),
    tool_name: z.string().describe("要调用的工具名称"),
    tool_arguments: z.record(z.any()).default({}).describe("传递给工具的参数。根据目标工具的schema提供相应的参数。"),
    return_raw: z.boolean().default(false).describe("是否返回原始响应（true）或格式化后的文本（false）")
  }
}, async ({ server_command, tool_name, tool_arguments = {}, return_raw = false }) => {
  // 使用统一的路径解析函数
  const parsedCommand = parseServerCommand(server_command);
  const { executable, scriptPath, args: parsedArgs } = parsedCommand;
  const allArgs = [scriptPath, ...parsedArgs];

  const client = new MCPClient();
  let callResult = {
    tool: tool_name,
    arguments: tool_arguments,
    success: false,
    response: null,
    error: null,
    executionTime: 0
  };

  try {
    // 连接到服务器
    await client.connect(executable, allArgs);
    
    // 初始化
    await client.initialize();
    
    // 获取工具列表以验证工具存在
    const tools = await client.listTools();
    const targetTool = tools.find(t => t.name === tool_name);
    
    if (!targetTool) {
      throw new Error(`未找到工具: ${tool_name}。可用的工具: ${tools.map(t => t.name).join(', ')}`);
    }

    // 调用工具
    const startTime = Date.now();
    const response = await client.callTool(tool_name, tool_arguments);
    callResult.executionTime = Date.now() - startTime;
    
    callResult.success = true;
    callResult.response = response;
    
  } catch (error) {
    callResult.error = error.message;
  } finally {
    client.disconnect();
  }

  // 根据return_raw参数决定返回格式
  if (return_raw) {
    // 返回原始响应
    if (callResult.error) {
      throw new Error(callResult.error);
    }
    return callResult.response;
  } else {
    // 返回格式化的报告
    let report = `## 🔧 工具调用结果\n\n`;
    report += `**工具名称**: ${tool_name}\n`;
    report += `**执行状态**: ${callResult.success ? '✅ 成功' : '❌ 失败'}\n`;
    report += `**执行时间**: ${callResult.executionTime}ms\n\n`;
    
    if (Object.keys(tool_arguments).length > 0) {
      report += `### 📤 请求参数:\n\`\`\`json\n${JSON.stringify(tool_arguments, null, 2)}\n\`\`\`\n\n`;
    }
    
    if (callResult.success) {
      report += `### 📥 响应结果:\n`;
      
      // 尝试从响应中提取文本内容
      if (callResult.response && callResult.response.content) {
        const textContent = callResult.response.content
          .filter(item => item.type === 'text')
          .map(item => item.text)
          .join('\n');
        
        if (textContent) {
          report += `${textContent}\n\n`;
        }
        
        // 如果有非文本内容，显示完整响应
        const hasNonText = callResult.response.content.some(item => item.type !== 'text');
        if (hasNonText || !textContent) {
          report += `\n**完整响应**:\n\`\`\`json\n${JSON.stringify(callResult.response, null, 2)}\n\`\`\``;
        }
      } else {
        report += `\`\`\`json\n${JSON.stringify(callResult.response, null, 2)}\n\`\`\``;
      }
    } else {
      report += `### ❌ 错误信息:\n${callResult.error}`;
    }
    
    return {
      content: [
        {
          type: "text",
          text: report,
        },
      ],
    };
  }
});

// 注册 batch_test_tools 工具
server.registerTool("batch_test_tools", {
  title: "Batch Test Tools",
  description: "批量测试多个MCP工具，支持为每个工具指定不同的测试参数",
  inputSchema: {
    server_command: z.string().describe("MCP服务器启动命令。支持多种格式：\n- Windows路径（反斜杠）：D:\\Path\\To\\script.js\n- Unix路径（正斜杠）：D:/Path/To/script.js 或 /path/to/script.js\n- 带引号路径（处理空格）：\"D:\\My Path\\script.js\"\n- 带执行器：node D:\\Path\\script.js 或 python script.py\n- 相对路径：./script.js 或 ../folder/script.js"),
    test_cases: z.array(z.object({
      tool_name: z.string().describe("工具名称"),
      arguments: z.record(z.any()).describe("传递给工具的参数"),
      description: z.string().optional().describe("测试用例描述（可选）")
    })).describe("测试用例列表，每个用例包含工具名和参数"),
    parallel: z.boolean().default(false).describe("是否并行执行测试（false为串行）"),
    stop_on_error: z.boolean().default(false).describe("遇到错误时是否停止后续测试")
  }
}, async ({ server_command, test_cases, parallel = false, stop_on_error = false }) => {
  if (!test_cases || test_cases.length === 0) {
    throw new Error("请提供至少一个测试用例");
  }

  // 使用统一的路径解析函数
  const parsedCommand = parseServerCommand(server_command);
  const { executable, scriptPath, args: parsedArgs } = parsedCommand;
  const allArgs = [scriptPath, ...parsedArgs];

  const client = new MCPClient();
  const testResults = {
    total_cases: test_cases.length,
    successful: 0,
    failed: 0,
    execution_time: 0,
    results: []
  };

  const startTime = Date.now();

  try {
    // 连接并初始化
    await client.connect(executable, allArgs);
    await client.initialize();
    
    // 获取可用工具列表
    const availableTools = await client.listTools();
    const toolNames = availableTools.map(t => t.name);

    if (parallel) {
      // 并行执行测试
      const promises = test_cases.map(async (testCase) => {
        const { tool_name, arguments: toolArgs, description } = testCase;
        
        if (!toolNames.includes(tool_name)) {
          return {
            tool_name,
            description,
            success: false,
            error: `工具 ${tool_name} 不存在`,
            arguments: toolArgs
          };
        }

        try {
          const toolStart = Date.now();
          const response = await client.callTool(tool_name, toolArgs);
          return {
            tool_name,
            description,
            success: true,
            response,
            arguments: toolArgs,
            execution_time: Date.now() - toolStart
          };
        } catch (error) {
          return {
            tool_name,
            description,
            success: false,
            error: error.message,
            arguments: toolArgs
          };
        }
      });

      testResults.results = await Promise.all(promises);
    } else {
      // 串行执行测试
      for (const testCase of test_cases) {
        const { tool_name, arguments: toolArgs, description } = testCase;
        
        if (!toolNames.includes(tool_name)) {
          const result = {
            tool_name,
            description,
            success: false,
            error: `工具 ${tool_name} 不存在`,
            arguments: toolArgs
          };
          testResults.results.push(result);
          
          if (stop_on_error) {
            break;
          }
          continue;
        }

        try {
          const toolStart = Date.now();
          const response = await client.callTool(tool_name, toolArgs);
          testResults.results.push({
            tool_name,
            description,
            success: true,
            response,
            arguments: toolArgs,
            execution_time: Date.now() - toolStart
          });
        } catch (error) {
          testResults.results.push({
            tool_name,
            description,
            success: false,
            error: error.message,
            arguments: toolArgs
          });
          
          if (stop_on_error) {
            break;
          }
        }
      }
    }

    // 统计结果
    testResults.successful = testResults.results.filter(r => r.success).length;
    testResults.failed = testResults.results.filter(r => !r.success).length;
    testResults.execution_time = Date.now() - startTime;

  } catch (error) {
    throw new Error(`批量测试失败: ${error.message}`);
  } finally {
    client.disconnect();
  }

  // 生成报告
  const report = `# 批量测试报告

## 📊 测试概览
- **测试用例总数**: ${testResults.total_cases}
- **成功**: ${testResults.successful} (${Math.round(testResults.successful / testResults.total_cases * 100)}%)
- **失败**: ${testResults.failed} (${Math.round(testResults.failed / testResults.total_cases * 100)}%)
- **总执行时间**: ${testResults.execution_time}ms
- **执行模式**: ${parallel ? '并行' : '串行'}

## 📝 详细结果

${testResults.results.map((result, index) => {
  const icon = result.success ? '✅' : '❌';
  let details = `### ${index + 1}. ${icon} ${result.tool_name}`;
  
  if (result.description) {
    details += `\n**描述**: ${result.description}`;
  }
  
  details += `\n**状态**: ${result.success ? '成功' : '失败'}`;
  
  if (result.execution_time) {
    details += `\n**执行时间**: ${result.execution_time}ms`;
  }
  
  details += `\n\n**请求参数**:\n\`\`\`json\n${JSON.stringify(result.arguments, null, 2)}\n\`\`\``;
  
  if (result.success && result.response) {
    // 提取文本响应
    const textContent = result.response.content
      ?.filter(item => item.type === 'text')
      ?.map(item => item.text)
      ?.join('\n');
    
    if (textContent) {
      details += `\n\n**响应结果**:\n${textContent}`;
    } else {
      details += `\n\n**响应结果**:\n\`\`\`json\n${JSON.stringify(result.response, null, 2)}\n\`\`\``;
    }
  } else if (!result.success) {
    details += `\n\n**错误信息**:\n${result.error}`;
  }
  
  return details;
}).join('\n\n---\n\n')}

## 📈 性能统计
- **平均执行时间**: ${Math.round(
  testResults.results
    .filter(r => r.execution_time)
    .reduce((sum, r) => sum + r.execution_time, 0) / 
  testResults.results.filter(r => r.execution_time).length || 0
)}ms`;

  return {
    content: [
      {
        type: "text",
        text: report,
      },
    ],
  };
});

// 注册 validate_mcp_tools 工具
server.registerTool("validate_mcp_tools", {
  title: "Validate MCP Tools",
  description: "验证MCP工具的schema和功能完整性",
  inputSchema: {
    server_command: z.string().describe("MCP服务器启动命令"),
    tool_name: z.string().optional().describe("要测试的特定工具名称（可选）"),
    test_params: z.record(z.any()).default({}).describe("测试工具时使用的参数。如果指定了tool_name，直接传递该工具的参数；否则传递一个对象，键为工具名，值为对应参数。示例：测试单个工具时 {\"a\": 10, \"b\": 20}，测试多个工具时 {\"add\": {\"a\": 10, \"b\": 20}, \"multiply\": {\"x\": 3, \"y\": 4}}")
  }
}, async ({ server_command, tool_name, test_params = {} }) => {
  if (!server_command) {
    throw new Error("请指定server_command参数");
  }

  // 使用统一的路径解析函数处理各种路径格式
  const parsedCommand = parseServerCommand(server_command);
  const { executable, scriptPath, args: parsedArgs } = parsedCommand;
  const allArgs = [scriptPath, ...parsedArgs];

  const client = new MCPClient();
  const validationResults = {
    totalTools: 0,
    validatedTools: [],
    schemaValidation: [],
    errors: [],
    warnings: []
  };

  try {
    // 连接并初始化
    await client.connect(executable, allArgs);
    await client.initialize();
    
    // 获取工具列表
    const tools = await client.listTools();
    validationResults.totalTools = tools.length;

    // 过滤要测试的工具
    const toolsToTest = tool_name 
      ? tools.filter(t => t.name === tool_name)
      : tools;

    if (tool_name && toolsToTest.length === 0) {
      throw new Error(`未找到工具: ${tool_name}`);
    }

    // 验证每个工具
    for (const tool of toolsToTest) {
      const toolValidation = {
        name: tool.name,
        description: tool.description,
        schemaValid: true,
        testResult: null,
        issues: []
      };

      // 验证schema
      if (!tool.inputSchema) {
        toolValidation.issues.push('缺少inputSchema');
        toolValidation.schemaValid = false;
      } else {
        // 检查schema结构
        if (!tool.inputSchema.type) {
          toolValidation.issues.push('inputSchema缺少type字段');
          toolValidation.schemaValid = false;
        }
        if (tool.inputSchema.type === 'object' && !tool.inputSchema.properties) {
          toolValidation.issues.push('object类型的schema缺少properties');
          toolValidation.schemaValid = false;
        }
      }

      // 尝试调用工具进行测试
      if (toolValidation.schemaValid) {
        try {
          // 智能处理test_params：
          // 1. 如果指定了tool_name且test_params不为空，直接使用test_params作为参数
          // 2. 否则，从test_params[tool.name]获取参数
          // 3. 如果都没有，生成示例参数
          let testArgs;
          if (tool_name && Object.keys(test_params).length > 0 && !test_params[tool.name]) {
            // 测试单个工具时，直接使用test_params
            testArgs = test_params;
          } else if (test_params[tool.name]) {
            // 从test_params对象中获取对应工具的参数
            testArgs = test_params[tool.name];
          } else {
            // 生成示例参数
            testArgs = generateExampleCall(tool);
          }
          
          const startTime = Date.now();
          const result = await client.callTool(tool.name, testArgs);
          const executionTime = Date.now() - startTime;

          toolValidation.testResult = {
            success: true,
            executionTime,
            responseValid: validateToolResponse(result),
            testArgs,
            actualResponse: result  // 保存实际响应
          };

          if (!toolValidation.testResult.responseValid) {
            toolValidation.issues.push('响应格式不符合MCP规范');
          }
        } catch (error) {
          // 同样的逻辑处理失败时的testArgs
          let testArgs;
          if (tool_name && Object.keys(test_params).length > 0 && !test_params[tool.name]) {
            testArgs = test_params;
          } else if (test_params[tool.name]) {
            testArgs = test_params[tool.name];
          } else {
            testArgs = generateExampleCall(tool);
          }
          
          toolValidation.testResult = {
            success: false,
            error: error.message,
            testArgs  // 即使失败也记录请求参数
          };
          
          // 分析错误类型
          if (error.message.includes('required')) {
            toolValidation.issues.push('必需参数验证失败');
          } else if (error.message.includes('type')) {
            toolValidation.issues.push('参数类型验证失败');
          }
        }
      }

      validationResults.validatedTools.push(toolValidation);
      validationResults.schemaValidation.push({
        tool: tool.name,
        valid: toolValidation.schemaValid,
        issues: toolValidation.issues
      });
    }

  } catch (error) {
    validationResults.errors.push(error.message);
  } finally {
    client.disconnect();
  }

  // 生成验证报告
  const report = `# MCP工具验证报告

## 📊 验证概览
- **测试范围**: ${tool_name || '所有工具'}
- **工具总数**: ${validationResults.totalTools}
- **验证工具数**: ${validationResults.validatedTools.length}
- **验证时间**: ${new Date().toISOString()}

## 🔍 详细验证结果

${validationResults.validatedTools.map(tool => {
  const statusIcon = tool.schemaValid && tool.testResult?.success ? '✅' : 
                     tool.schemaValid ? '⚠️' : '❌';
  
  return `### ${statusIcon} ${tool.name}

**描述**: ${tool.description || '无描述'}

**Schema验证**: ${tool.schemaValid ? '✅ 通过' : '❌ 失败'}

${tool.testResult ? `**功能测试**: ${tool.testResult.success ? '✅ 成功' : '❌ 失败'}
${tool.testResult.executionTime ? `- 执行时间: ${tool.testResult.executionTime}ms` : ''}
${tool.testResult.error ? `- 错误: ${tool.testResult.error}` : ''}
${tool.testResult.responseValid !== undefined ? `- 响应格式: ${tool.testResult.responseValid ? '✅ 有效' : '❌ 无效'}` : ''}

#### 📤 请求参数:
\`\`\`json
${JSON.stringify(tool.testResult.testArgs, null, 2)}
\`\`\`

${tool.testResult.actualResponse ? `#### 📥 实际响应:
\`\`\`json
${JSON.stringify(tool.testResult.actualResponse, null, 2)}
\`\`\`` : ''}` : '**功能测试**: 未执行'}

${tool.issues.length > 0 ? `**发现的问题**:\n${tool.issues.map(i => `- ${i}`).join('\n')}` : '**问题**: 无'}
`;
}).join('\n---\n\n')}

## 📈 统计摘要

- **Schema验证通过率**: ${Math.round((validationResults.schemaValidation.filter(v => v.valid).length / validationResults.schemaValidation.length) * 100)}%
- **功能测试通过率**: ${Math.round((validationResults.validatedTools.filter(t => t.testResult?.success).length / validationResults.validatedTools.length) * 100)}%

${validationResults.errors.length > 0 ? `## ⚠️ 错误\n${validationResults.errors.map(e => `- ${e}`).join('\n')}` : ''}`;

  return {
    content: [
      {
        type: "text",
        text: report,
      },
    ],
  };
});

// 验证工具响应格式
function validateToolResponse(response) {
  if (!response) return false;
  if (!response.content) return false;
  if (!Array.isArray(response.content)) return false;
  
  for (const item of response.content) {
    if (!item.type) return false;
    if (item.type === 'text' && typeof item.text !== 'string') return false;
  }
  
  return true;
}

// 工具参数生成函数
function generateExampleCall(tool) {
  const properties = tool.inputSchema?.properties || {};
  const example = {};
  
  // 通用的参数值生成逻辑
  for (const [key, schema] of Object.entries(properties)) {
    if (schema.example !== undefined) {
      example[key] = schema.example;
    } else if (schema.default !== undefined) {
      example[key] = schema.default;
    } else if (schema.enum) {
      example[key] = schema.enum[0];
    } else {
      // 根据数据类型生成通用示例值
      switch (schema.type) {
        case 'number':
        case 'integer':
          example[key] = key.toLowerCase().includes('id') ? 1 : 
                       key.toLowerCase().includes('count') ? 5 :
                       key.toLowerCase().includes('size') ? 100 :
                       key.toLowerCase().includes('limit') ? 10 : 42;
          break;
        
        case 'string':
          if (schema.format === 'email') {
            example[key] = 'example@email.com';
          } else if (schema.format === 'uri' || schema.format === 'url') {
            example[key] = 'https://example.com';
          } else if (key.toLowerCase().includes('name')) {
            example[key] = 'ExampleName';
          } else if (key.toLowerCase().includes('path')) {
            example[key] = '/example/path';
          } else {
            example[key] = `example_${key}`;
          }
          break;
        
        case 'boolean':
          example[key] = true;
          break;
        
        case 'array':
          if (schema.items?.type === 'string') {
            example[key] = ['item1', 'item2'];
          } else if (schema.items?.type === 'number') {
            example[key] = [1, 2, 3];
          } else {
            example[key] = ['example'];
          }
          break;
        
        case 'object':
          example[key] = { example: 'value' };
          break;
        
        default:
          example[key] = `example_${key}_value`;
      }
    }
  }
  
  return example;
}

// 创建传输层并连接服务器
const transport = new StdioServerTransport();
await server.connect(transport);
console.log("MCP Tester 已启动");
