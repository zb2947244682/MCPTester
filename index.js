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
          console.error('[MCP Server Debug]:', data.toString());
        });

        // 处理进程错误
        this.process.on('error', (error) => {
          reject(new Error(`启动MCP服务器失败: ${error.message}`));
        });

        // 进程退出处理
        this.process.on('exit', (code, signal) => {
          if (code !== 0 && code !== null && signal !== 'SIGTERM') {
            console.error(`MCP服务器异常退出，退出码: ${code}, 信号: ${signal}`);
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
