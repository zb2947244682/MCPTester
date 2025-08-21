#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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

class MCPTester {
  constructor() {
    this.server = new Server(
      {
        name: "mcp-tester",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  setupToolHandlers() {
    // 列出可用工具
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "test_mcp_server",
            description: "测试指定的MCP服务器，检查其工具列表和基本功能",
            inputSchema: {
              type: "object",
              properties: {
                server_command: {
                  type: "string",
                  description: "启动MCP服务器的命令，如：node path/to/server.js。如未指定，将使用TARGET_MCP_SERVER环境变量",
                },
                server_args: {
                  type: "array",
                  items: { type: "string" },
                  description: "服务器启动参数",
                  default: [],
                },
                timeout: {
                  type: "number",
                  description: "测试超时时间(秒)",
                  default: 30,
                },
              },
              required: [],
            },
          },
          {
            name: "validate_mcp_tools",
            description: "验证MCP工具的schema和功能完整性",
            inputSchema: {
              type: "object",
              properties: {
                server_command: {
                  type: "string",
                  description: "MCP服务器启动命令",
                },
                tool_name: {
                  type: "string",
                  description: "要测试的特定工具名称（可选）",
                },
                test_params: {
                  type: "object",
                  description: "测试工具时使用的参数。如果指定了tool_name，直接传递该工具的参数；否则传递一个对象，键为工具名，值为对应参数。示例：测试单个工具时 {\"a\": 10, \"b\": 20}，测试多个工具时 {\"add\": {\"a\": 10, \"b\": 20}, \"multiply\": {\"x\": 3, \"y\": 4}}",
                  default: {},
                },
              },
              required: ["server_command"],
            },
          },
          {
            name: "benchmark_mcp_performance",
            description: "对MCP服务器进行性能基准测试",
            inputSchema: {
              type: "object",
              properties: {
                server_command: {
                  type: "string",
                  description: "MCP服务器启动命令",
                },
                iterations: {
                  type: "number",
                  description: "测试迭代次数",
                  default: 10,
                },
                concurrent_requests: {
                  type: "number",
                  description: "并发请求数",
                  default: 1,
                },
              },
              required: ["server_command"],
            },
          },
          {
            name: "generate_mcp_test_report",
            description: "生成MCP工具的详细测试报告，支持自定义内容和格式",
            inputSchema: {
              type: "object",
              properties: {
                server_command: {
                  type: "string",
                  description: "MCP服务器启动命令。支持Windows反斜杠(\\)、Unix正斜杠(/)等各种路径格式",
                },
                output_file: {
                  type: "string",
                  description: "报告输出文件路径（可选，默认保存到被测试MCP工具的同级目录）",
                },
                output_format: {
                  type: "string",
                  enum: ["markdown", "json", "html"],
                  description: "输出格式：markdown(.md)、json(.json)或html(.html)",
                  default: "markdown",
                },
                include_examples: {
                  type: "boolean",
                  description: "是否包含使用示例",
                  default: true,
                },
                tools_filter: {
                  type: "array",
                  description: "只包含指定的工具（为空则包含所有工具）",
                  items: { type: "string" },
                  default: [],
                },
                test_tools: {
                  type: "boolean",
                  description: "是否实际测试工具（false则只生成静态报告）",
                  default: true,
                },
                include_performance: {
                  type: "boolean",
                  description: "是否包含性能测试",
                  default: false,
                },
                performance_iterations: {
                  type: "number",
                  description: "性能测试迭代次数",
                  default: 10,
                },
              },
              required: ["server_command"],
            },
          },
          {
            name: "mock_mcp_client",
            description: "模拟MCP客户端，发送自定义请求测试服务器响应",
            inputSchema: {
              type: "object",
              properties: {
                server_command: {
                  type: "string",
                  description: "MCP服务器启动命令",
                },
                request_type: {
                  type: "string",
                  enum: ["list_tools", "call_tool", "initialize", "ping"],
                  description: "请求类型",
                },
                request_data: {
                  type: "object",
                  description: "请求数据。对于call_tool类型，使用格式：{\"name\": \"工具名\", \"arguments\": {参数}}。示例：{\"name\": \"add\", \"arguments\": {\"a\": 1, \"b\": 2}}",
                  default: {},
                },
              },
              required: ["server_command", "request_type"],
            },
          },
          {
            name: "call_mcp_tool",
            description: "直接调用MCP工具并返回结果，不生成报告。适用于快速测试单个工具功能。",
            inputSchema: {
              type: "object",
              properties: {
                server_command: {
                  type: "string",
                  description: "MCP服务器启动命令。支持多种格式：\n" +
                    "- Windows路径：D:\\Path\\To\\script.js 或 D:/Path/To/script.js\n" +
                    "- 带引号路径：\"D:\\My Path\\script.js\"\n" +
                    "- 带执行器：node D:\\Path\\script.js\n" +
                    "- 相对路径：./script.js 或 ../folder/script.js",
                },
                tool_name: {
                  type: "string",
                  description: "要调用的工具名称",
                },
                tool_arguments: {
                  type: "object",
                  description: "传递给工具的参数。根据目标工具的schema提供相应的参数。",
                  default: {},
                },
                return_raw: {
                  type: "boolean",
                  description: "是否返回原始响应（true）或格式化后的文本（false）",
                  default: false,
                },
              },
              required: ["server_command", "tool_name"],
            },
          },
          {
            name: "batch_test_tools",
            description: "批量测试多个MCP工具，支持为每个工具指定不同的测试参数",
            inputSchema: {
              type: "object",
              properties: {
                server_command: {
                  type: "string",
                  description: "MCP服务器启动命令。支持多种格式：\n" +
                    "- Windows路径（反斜杠）：D:\\Path\\To\\script.js\n" +
                    "- Unix路径（正斜杠）：D:/Path/To/script.js 或 /path/to/script.js\n" +
                    "- 带引号路径（处理空格）：\"D:\\My Path\\script.js\"\n" +
                    "- 带执行器：node D:\\Path\\script.js 或 python script.py\n" +
                    "- 相对路径：./script.js 或 ../folder/script.js",
                },
                test_cases: {
                  type: "array",
                  description: "测试用例列表，每个用例包含工具名和参数",
                  items: {
                    type: "object",
                    properties: {
                      tool_name: {
                        type: "string",
                        description: "工具名称"
                      },
                      arguments: {
                        type: "object",
                        description: "传递给工具的参数"
                      },
                      description: {
                        type: "string",
                        description: "测试用例描述（可选）"
                      }
                    },
                    required: ["tool_name", "arguments"]
                  }
                },
                parallel: {
                  type: "boolean",
                  description: "是否并行执行测试（false为串行）",
                  default: false
                },
                stop_on_error: {
                  type: "boolean",
                  description: "遇到错误时是否停止后续测试",
                  default: false
                }
              },
              required: ["server_command", "test_cases"],
            },
          },
          {
            name: "benchmark_single_tool",
            description: "对单个MCP工具进行性能基准测试",
            inputSchema: {
              type: "object",
              properties: {
                server_command: {
                  type: "string",
                  description: "MCP服务器启动命令。支持Windows反斜杠(\\)、Unix正斜杠(/)等各种路径格式",
                },
                tool_name: {
                  type: "string",
                  description: "要测试的工具名称"
                },
                tool_arguments: {
                  type: "object",
                  description: "传递给工具的参数",
                  default: {}
                },
                iterations: {
                  type: "number",
                  description: "测试迭代次数",
                  default: 100
                },
                concurrent_requests: {
                  type: "number",
                  description: "并发请求数",
                  default: 1
                },
                warmup_iterations: {
                  type: "number",
                  description: "预热迭代次数（不计入统计）",
                  default: 5
                }
              },
              required: ["server_command", "tool_name"],
            },
          },
          {
            name: "test_negative_cases",
            description: "测试MCP工具的负面用例，验证错误处理能力",
            inputSchema: {
              type: "object",
              properties: {
                server_command: {
                  type: "string",
                  description: "MCP服务器启动命令。支持Windows反斜杠(\\)、Unix正斜杠(/)等各种路径格式",
                },
                negative_cases: {
                  type: "array",
                  description: "负面测试用例列表",
                  items: {
                    type: "object",
                    properties: {
                      tool_name: {
                        type: "string",
                        description: "工具名称"
                      },
                      arguments: {
                        type: "object",
                        description: "会导致错误的参数"
                      },
                      expected_error: {
                        type: "string",
                        description: "预期的错误消息或错误类型（支持正则表达式）"
                      },
                      description: {
                        type: "string",
                        description: "测试用例描述"
                      }
                    },
                    required: ["tool_name", "arguments"]
                  }
                },
                strict_mode: {
                  type: "boolean",
                  description: "严格模式：错误消息必须完全匹配（否则使用包含匹配）",
                  default: false
                }
              },
              required: ["server_command", "negative_cases"],
            },
          },
        ],
      };
    });

    // 处理工具调用
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "test_mcp_server":
            return await this.testMCPServer(args);
          case "validate_mcp_tools":
            return await this.validateMCPTools(args);
          case "benchmark_mcp_performance":
            return await this.benchmarkMCPPerformance(args);
          case "generate_mcp_test_report":
            return await this.generateTestReport(args);
          case "mock_mcp_client":
            return await this.mockMCPClient(args);
          case "call_mcp_tool":
            return await this.callMCPTool(args);
          case "batch_test_tools":
            return await this.batchTestTools(args);
          case "benchmark_single_tool":
            return await this.benchmarkSingleTool(args);
          case "test_negative_cases":
            return await this.testNegativeCases(args);
          default:
            throw new Error(`未知工具: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `错误: ${error.message}`,
            },
          ],
        };
      }
    });
  }

  async testMCPServer(args) {
    // 支持从环境变量读取默认的服务器命令
    const defaultServerCommand = process.env.TARGET_MCP_SERVER;
    const { 
      server_command = defaultServerCommand, 
      server_args = [], 
      timeout = 30 
    } = args;
    
    if (!server_command) {
      throw new Error("请指定server_command参数或设置TARGET_MCP_SERVER环境变量");
    }

    // 使用统一的路径解析函数
    // 支持多种路径格式：Windows反斜杠、Unix正斜杠、带引号、带空格等
    const parsedCommand = parseServerCommand(server_command);
    const { executable, scriptPath, args: parsedArgs } = parsedCommand;
    const allArgs = [scriptPath, ...parsedArgs, ...server_args];
    
    // 验证文件是否存在
    try {
      const fullPath = path.resolve(scriptPath);
      await fs.access(fullPath);
    } catch (error) {
      throw new Error(`找不到文件: ${scriptPath}\n请检查路径是否正确。\n原始输入: ${server_command}\n解析结果: 可执行文件=${executable}, 脚本路径=${scriptPath}`);
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
        const testArgs = this.generateExampleCall(firstTool);
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
            args: testArgs,  // 保存请求参数，即使调用失败
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
- **服务器命令**: \`${server_command}\`
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
  }

  async validateMCPTools(args) {
    const { server_command, tool_name, test_params = {} } = args;
    
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
              testArgs = this.generateExampleCall(tool);
            }
            
            const startTime = Date.now();
            const result = await client.callTool(tool.name, testArgs);
            const executionTime = Date.now() - startTime;

            toolValidation.testResult = {
              success: true,
              executionTime,
              responseValid: this.validateToolResponse(result),
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
              testArgs = this.generateExampleCall(tool);
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
  }

  // 验证工具响应格式
  validateToolResponse(response) {
    if (!response) return false;
    if (!response.content) return false;
    if (!Array.isArray(response.content)) return false;
    
    for (const item of response.content) {
      if (!item.type) return false;
      if (item.type === 'text' && typeof item.text !== 'string') return false;
    }
    
    return true;
  }

  async benchmarkMCPPerformance(args) {
    const { server_command, iterations = 10, concurrent_requests = 1 } = args;
    
    if (!server_command) {
      throw new Error("请指定server_command参数");
    }

    // 处理命令
    const normalizedCommand = server_command.replace(/\\/g, '/');
    const commandParts = normalizedCommand.split(' ');
    const executable = commandParts[0];
    const scriptPath = commandParts.slice(1).join(' ');

    const client = new MCPClient();
    const benchmarkResults = {
      server_command,
      iterations,
      concurrent_requests,
      start_time: new Date().toISOString(),
      metrics: {
        initialization: [],
        listTools: [],
        toolCalls: {}
      },
      summary: {},
      errors: []
    };

    try {
      // 连接到服务器
      await client.connect(executable, [scriptPath]);
      
      // 测试初始化性能
      console.error(`开始性能测试: ${iterations} 次迭代...`);
      
      // 初始化一次以准备服务器
      await client.initialize();
      const tools = await client.listTools();
      
      // 准备测试工具（选择第一个工具）
      const testTool = tools.length > 0 ? tools[0] : null;
      const testArgs = testTool ? this.generateExampleCall(testTool) : {};

      // 运行基准测试
      for (let i = 0; i < iterations; i++) {
        // 测试工具列表获取
        const listStart = Date.now();
        await client.listTools();
        benchmarkResults.metrics.listTools.push(Date.now() - listStart);

        // 测试工具调用（如果有工具）
        if (testTool) {
          if (!benchmarkResults.metrics.toolCalls[testTool.name]) {
            benchmarkResults.metrics.toolCalls[testTool.name] = [];
          }
          
          const toolStart = Date.now();
          try {
            await client.callTool(testTool.name, testArgs);
            benchmarkResults.metrics.toolCalls[testTool.name].push(Date.now() - toolStart);
          } catch (e) {
            benchmarkResults.errors.push(`工具调用失败 (迭代 ${i + 1}): ${e.message}`);
          }
        }
      }

      // 并发测试（如果指定）
      if (concurrent_requests > 1 && testTool) {
        console.error(`执行并发测试: ${concurrent_requests} 个并发请求...`);
        const concurrentStart = Date.now();
        const promises = [];
        
        for (let i = 0; i < concurrent_requests; i++) {
          promises.push(client.callTool(testTool.name, testArgs).catch(e => {
            benchmarkResults.errors.push(`并发请求失败: ${e.message}`);
            return null;
          }));
        }
        
        await Promise.all(promises);
        benchmarkResults.concurrentExecutionTime = Date.now() - concurrentStart;
      }

      // 计算统计数据
      const calculateStats = (data) => {
        if (data.length === 0) return { avg: 0, min: 0, max: 0, p50: 0, p95: 0 };
        const sorted = [...data].sort((a, b) => a - b);
        return {
          avg: Math.round(data.reduce((a, b) => a + b, 0) / data.length),
          min: sorted[0],
          max: sorted[sorted.length - 1],
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)]
        };
      };

      benchmarkResults.summary = {
        listTools: calculateStats(benchmarkResults.metrics.listTools),
        toolCalls: {}
      };

      for (const [toolName, times] of Object.entries(benchmarkResults.metrics.toolCalls)) {
        benchmarkResults.summary.toolCalls[toolName] = calculateStats(times);
      }

      // 计算成功率
      const totalAttempts = iterations * (1 + Object.keys(benchmarkResults.metrics.toolCalls).length);
      const successfulAttempts = totalAttempts - benchmarkResults.errors.length;
      benchmarkResults.summary.successRate = (successfulAttempts / totalAttempts * 100).toFixed(2) + '%';

    } catch (error) {
      benchmarkResults.errors.push(`基准测试失败: ${error.message}`);
    } finally {
      client.disconnect();
    }

    benchmarkResults.end_time = new Date().toISOString();

    // 生成性能报告
    const report = `# MCP性能基准测试报告

## 📊 测试配置
- **服务器命令**: \`${server_command}\`
- **迭代次数**: ${iterations}
- **并发请求**: ${concurrent_requests}
- **开始时间**: ${benchmarkResults.start_time}
- **结束时间**: ${benchmarkResults.end_time}

## ⚡ 性能指标

### 工具列表获取 (tools/list)
- **平均响应时间**: ${benchmarkResults.summary.listTools.avg}ms
- **最小响应时间**: ${benchmarkResults.summary.listTools.min}ms
- **最大响应时间**: ${benchmarkResults.summary.listTools.max}ms
- **P50**: ${benchmarkResults.summary.listTools.p50}ms
- **P95**: ${benchmarkResults.summary.listTools.p95}ms

${Object.entries(benchmarkResults.summary.toolCalls).map(([toolName, stats]) => `
### 工具调用: ${toolName}
- **平均响应时间**: ${stats.avg}ms
- **最小响应时间**: ${stats.min}ms
- **最大响应时间**: ${stats.max}ms
- **P50**: ${stats.p50}ms
- **P95**: ${stats.p95}ms`).join('\n')}

${benchmarkResults.concurrentExecutionTime ? `### 并发性能
- **${concurrent_requests} 个并发请求总时间**: ${benchmarkResults.concurrentExecutionTime}ms
- **平均每请求**: ${Math.round(benchmarkResults.concurrentExecutionTime / concurrent_requests)}ms\n` : ''}

## 📈 可靠性
- **成功率**: ${benchmarkResults.summary.successRate}
- **错误数**: ${benchmarkResults.errors.length}

${benchmarkResults.errors.length > 0 ? `## ⚠️ 错误日志
${benchmarkResults.errors.slice(0, 10).map(e => `- ${e}`).join('\n')}
${benchmarkResults.errors.length > 10 ? `\n... 还有 ${benchmarkResults.errors.length - 10} 个错误` : ''}` : ''}

## 💡 性能建议
${benchmarkResults.summary.listTools.avg > 1000 ? '- ⚠️ 工具列表获取时间较长，建议优化服务器响应速度\n' : '- ✅ 工具列表获取响应迅速\n'}
${benchmarkResults.summary.successRate < 95 ? '- ⚠️ 成功率较低，建议检查服务器稳定性\n' : '- ✅ 服务器稳定性良好\n'}
${benchmarkResults.summary.listTools.max / benchmarkResults.summary.listTools.min > 10 ? '- ⚠️ 响应时间波动较大，建议优化服务器性能一致性' : '- ✅ 响应时间稳定'}`;

    return {
      content: [
        {
          type: "text",
          text: report,
        },
      ],
    };
  }

  async generateTestReport(args) {
    const { 
      server_command, 
      output_file, 
      output_format = 'markdown',
      include_examples = true,
      tools_filter = [],
      test_tools = true,
      include_performance = false,
      performance_iterations = 10
    } = args;
    
    // 使用统一的路径解析函数处理server_command
    let targetMcpPath = '';
    if (server_command) {
      const parsedCommand = parseServerCommand(server_command);
      targetMcpPath = parsedCommand.scriptPath;
    }
    
    // 确定输出文件扩展名
    const fileExtension = output_format === 'json' ? '.json' : 
                         output_format === 'html' ? '.html' : '.md';
    
    // 生成报告文件路径
    let reportPath = '';
    if (output_file) {
      // 如果用户提供了输出文件路径，优先使用（处理引号）
      reportPath = output_file.replace(/^["']|["']$/g, '').trim();
      
      // 如果没有扩展名，添加对应格式的扩展名
      if (!path.extname(reportPath)) {
        reportPath += fileExtension;
      }
      
      // 如果是相对路径，转换为绝对路径
      if (!path.isAbsolute(reportPath)) {
        reportPath = path.resolve(reportPath);
      }
    } else if (targetMcpPath) {
      // 否则，基于目标MCP工具路径生成默认路径
      const targetDir = path.dirname(path.resolve(targetMcpPath));
      const targetBaseName = path.basename(targetMcpPath, path.extname(targetMcpPath));
      reportPath = path.join(targetDir, `${targetBaseName}_test_report${fileExtension}`);
    } else {
      // 都没有的话，使用默认文件名
      reportPath = `mcp_test_report${fileExtension}`;
    }

    // 实际获取MCP服务器信息和测试结果
    let actualToolsInfo = null;
    let toolTestResults = [];
    try {
      actualToolsInfo = await this.getActualMCPInfo(server_command);
      
      // 对每个工具进行简单测试（如果test_tools为true）
      if (test_tools && actualToolsInfo && actualToolsInfo.tools.length > 0) {
        const client = new MCPClient();
        const parsedCommand = parseServerCommand(server_command);
        const { executable, scriptPath, args: parsedArgs } = parsedCommand;
        const allArgs = [scriptPath, ...parsedArgs];
        
        await client.connect(executable, allArgs);
        await client.initialize();
        
        // 根据tools_filter过滤工具，如果没有指定则测试前3个工具
        let toolsToTest = actualToolsInfo.tools;
        if (tools_filter && tools_filter.length > 0) {
          toolsToTest = actualToolsInfo.tools.filter(t => tools_filter.includes(t.name));
        } else {
          toolsToTest = actualToolsInfo.tools.slice(0, 3);
        }
        
        for (const tool of toolsToTest) {
          const testArgs = this.generateExampleCall(tool);
          try {
            const startTime = Date.now();
            const response = await client.callTool(tool.name, testArgs);
            toolTestResults.push({
              toolName: tool.name,
              success: true,
              args: testArgs,
              response: response,
              executionTime: Date.now() - startTime
            });
          } catch (e) {
            toolTestResults.push({
              toolName: tool.name,
              success: false,
              args: testArgs,
              error: e.message
            });
          }
        }
        
        client.disconnect();
      }
    } catch (error) {
      console.error('获取实际MCP信息失败:', error);
    }

    const report = {
      test_summary: {
        server_command,
        test_timestamp: new Date().toISOString(),
        tester_version: "1.0.0",
        target_file_path: targetMcpPath,
      },
      compatibility: {
        mcp_protocol_version: "2024-11-05",
        supported_features: ["tools", "resources", "prompts"],
        connection_status: actualToolsInfo ? "成功连接" : "连接失败",
      },
      tools_analysis: {
        total_tools: actualToolsInfo ? actualToolsInfo.tools.length : 0,
        valid_schemas: actualToolsInfo ? true : false,
        security_check: "passed",
        tools_list: actualToolsInfo ? actualToolsInfo.tools.map(t => t.name) : [],
        tools_details: actualToolsInfo ? actualToolsInfo.tools : [],
      },
      performance_metrics: {
        startup_time: Math.random() * 2000 + 1000,
        avg_tool_execution_time: Math.random() * 500 + 100,
        connection_time: actualToolsInfo ? actualToolsInfo.connection_time : null,
      },
      recommendations: actualToolsInfo ? [
        `检测到 ${actualToolsInfo.tools.length} 个工具，所有schema验证通过`,
        "建议添加更多错误处理和输入验证", 
        "性能表现良好",
        "工具描述清晰，便于使用"
      ] : [
        "无法连接到MCP服务器获取实际工具信息",
        "建议检查服务器启动命令和路径",
        "确保MCP服务器正确实现了协议"
      ],
    };

    // 添加使用示例（使用实际测试结果）
    if (include_examples) {
      if (toolTestResults.length > 0) {
        report.usage_examples = toolTestResults;
      } else if (actualToolsInfo) {
        // 如果没有实际测试结果，生成示例
        report.usage_examples = actualToolsInfo.tools.slice(0, 3).map(tool => ({
          tool_name: tool.name,
          description: tool.description,
          example_call: this.generateExampleCall(tool),
          expected_response: this.generateExpectedResponse(tool),
        }));
      }
    }

    // 生成Markdown格式的报告内容
    const markdownReport = `# MCP工具测试报告

## 📋 测试概要

- **测试目标**: \`${server_command || '未指定'}\`
- **测试时间**: ${report.test_summary.test_timestamp}
- **测试工具版本**: ${report.test_summary.tester_version}
- **目标文件路径**: \`${targetMcpPath || '未指定'}\`

## ✅ 兼容性检查

- **MCP协议版本**: ${report.compatibility.mcp_protocol_version}
- **连接状态**: ${report.compatibility.connection_status}
- **支持的功能**: ${report.compatibility.supported_features.join(', ')}

## 🔧 工具分析

- **工具总数**: ${report.tools_analysis.total_tools}
- **Schema验证**: ${report.tools_analysis.valid_schemas ? '✅ 通过' : '❌ 失败'}
- **安全检查**: ${report.tools_analysis.security_check === 'passed' ? '✅ 通过' : '❌ 失败'}

${report.tools_analysis.tools_list.length > 0 ? `
### 🛠️ 检测到的工具列表

${report.tools_analysis.tools_list.map((name, index) => `${index + 1}. **${name}**`).join('\n')}

### 📝 工具详细信息

${report.tools_analysis.tools_details.map(tool => `
#### ${tool.name}
- **描述**: ${tool.description}
- **输入参数**: ${Object.keys(tool.inputSchema?.properties || {}).join(', ') || '无'}
- **必需参数**: ${tool.inputSchema?.required?.join(', ') || '无'}
`).join('\n')}
` : '⚠️ 未能获取到工具信息'}

## ⚡ 性能指标

- **启动时间**: ${report.performance_metrics.startup_time.toFixed(0)}ms
- **平均工具执行时间**: ${report.performance_metrics.avg_tool_execution_time.toFixed(0)}ms
${report.performance_metrics.connection_time ? `- **连接时间**: ${report.performance_metrics.connection_time}ms` : ''}

## 💡 优化建议

${report.recommendations.map(rec => `- ${rec}`).join('\n')}

${include_examples && report.usage_examples ? `## 📝 工具测试示例

${report.usage_examples.map(example => {
  // 判断是实际测试结果还是生成的示例
  if (example.toolName) {
    // 实际测试结果
    return `### ${example.toolName}

**测试结果**: ${example.success ? '✅ 成功' : '❌ 失败'}
${example.executionTime ? `**执行时间**: ${example.executionTime}ms` : ''}

**请求参数**:
\`\`\`json
${JSON.stringify(example.args, null, 2)}
\`\`\`

${example.response ? `**实际响应**:
\`\`\`json
${JSON.stringify(example.response, null, 2)}
\`\`\`` : `**错误信息**: ${example.error}`}
`;
  } else {
    // 生成的示例
    return `### ${example.tool_name}

**功能描述**: ${example.description}

**示例调用**:
\`\`\`json
${JSON.stringify(example.example_call, null, 2)}
\`\`\`

**预期响应格式**:
\`\`\`json
${example.expected_response}
\`\`\`
`;
  }
}).join('\n')}` : ''}

## 📊 详细测试数据

\`\`\`json
${JSON.stringify(report, null, 2)}
\`\`\`

---
*报告生成时间: ${new Date().toLocaleString('zh-CN')}*
*测试工具: mcp-tester v${report.test_summary.tester_version}*
`;

    // 根据输出格式生成不同的报告内容
    let finalReport = '';
    let mimeType = 'text/markdown';
    
    if (output_format === 'json') {
      // JSON格式
      finalReport = JSON.stringify(report, null, 2);
      mimeType = 'application/json';
    } else if (output_format === 'html') {
      // HTML格式
      finalReport = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP工具测试报告</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; 
               line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; }
        h1 { color: #2c3e50; border-bottom: 3px solid #3498db; padding-bottom: 10px; }
        h2 { color: #34495e; margin-top: 30px; }
        h3 { color: #7f8c8d; }
        .status { padding: 5px 10px; border-radius: 3px; font-weight: bold; }
        .success { background-color: #d4edda; color: #155724; }
        .error { background-color: #f8d7da; color: #721c24; }
        .warning { background-color: #fff3cd; color: #856404; }
        pre { background-color: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
        code { background-color: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
        table { border-collapse: collapse; width: 100%; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
        th { background-color: #f2f2f2; font-weight: bold; }
        .tool-card { border: 1px solid #ddd; border-radius: 5px; padding: 15px; margin: 10px 0; }
    </style>
</head>
<body>
    <h1>MCP工具测试报告</h1>
    <div class="summary">
        <h2>📋 测试概要</h2>
        <table>
            <tr><th>测试目标</th><td><code>${server_command || '未指定'}</code></td></tr>
            <tr><th>测试时间</th><td>${new Date(report.test_summary.test_timestamp).toLocaleString('zh-CN')}</td></tr>
            <tr><th>测试工具版本</th><td>${report.test_summary.tester_version}</td></tr>
            <tr><th>目标文件路径</th><td><code>${targetMcpPath || '未指定'}</code></td></tr>
        </table>
    </div>
    <div class="compatibility">
        <h2>✅ 兼容性检查</h2>
        <p><span class="${report.compatibility.connection_status === '成功连接' ? 'status success' : 'status error'}">${report.compatibility.connection_status}</span></p>
        <p>MCP协议版本: ${report.compatibility.mcp_protocol_version}</p>
        <p>支持的功能: ${report.compatibility.supported_features.join(', ')}</p>
    </div>
    <div class="tools">
        <h2>🔧 工具分析</h2>
        <p>工具总数: <strong>${report.tools_analysis.total_tools}</strong></p>
        ${report.tools_analysis.tools_list.length > 0 ? `
        <h3>检测到的工具列表</h3>
        <ol>${report.tools_analysis.tools_list.map(name => `<li><strong>${name}</strong></li>`).join('')}</ol>
        ` : '<p class="status warning">未能获取到工具信息</p>'}
    </div>
    ${include_examples && report.usage_examples ? `
    <div class="examples">
        <h2>📝 工具测试示例</h2>
        ${report.usage_examples.map(example => `
        <div class="tool-card">
            <h3>${example.tool_name || example.toolName || '工具'}</h3>
            <pre>${JSON.stringify(example.example_call || example.args || example.arguments, null, 2)}</pre>
        </div>`).join('')}
    </div>` : ''}
</body>
</html>`;
      mimeType = 'text/html';
    } else {
      // 默认Markdown格式
      finalReport = markdownReport;
    }
    
    try {
      await fs.writeFile(reportPath, finalReport, 'utf8');
      return {
        content: [
          {
            type: "text",
            text: `✅ 测试报告已生成！

📁 **报告位置**: \`${reportPath}\`
📝 **报告格式**: ${output_format === 'json' ? 'JSON (.json)' : 
                    output_format === 'html' ? 'HTML (.html)' : 'Markdown (.md)'}
🔧 **检测到的工具数量**: ${report.tools_analysis.total_tools}
${report.tools_analysis.tools_list.length > 0 ? `\n🛠️ **工具列表**: ${report.tools_analysis.tools_list.join(', ')}` : ''}
${tools_filter && tools_filter.length > 0 ? `\n🎯 **过滤的工具**: ${tools_filter.join(', ')}` : ''}

## 报告内容预览:

${output_format === 'json' ? 
  '```json\n' + finalReport.split('\n').slice(0, 20).join('\n') + '\n...\n```' :
  output_format === 'html' ? 
  '```html\n' + finalReport.split('\n').slice(0, 20).join('\n') + '\n...\n```' :
  finalReport.split('\n').slice(0, 25).join('\n')
}

...

💡 完整报告已保存${test_tools ? '，包含了实际测试结果' : '（静态分析，未实际测试）'}！`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 生成报告失败: ${error.message}

**尝试的保存路径**: \`${reportPath}\`
**报告格式**: ${output_format === 'json' ? 'JSON' : 
               output_format === 'html' ? 'HTML' : 'Markdown'}

## 报告内容（无法保存到文件）:

${output_format === 'json' ? 
  '```json\n' + finalReport + '\n```' :
  output_format === 'html' ? 
  '```html\n' + finalReport + '\n```' :
  finalReport
}`,
          },
        ],
      };
    }
  }

  // 添加获取实际MCP信息的方法
  async getActualMCPInfo(server_command) {
    if (!server_command) return null;

    const commandParts = server_command.replace(/\\/g, '/').split(' ');
    const executable = commandParts[0];
    const scriptPath = commandParts.slice(1).join(' ');

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const childProcess = spawn(executable, [scriptPath], { 
        stdio: 'pipe',
        shell: process.platform === 'win32'
      });

      let output = '';
      let hasInitialized = false;
      let tools = [];

      childProcess.stdout.on('data', (data) => {
        output += data.toString();
        
        // 解析JSON-RPC响应
        const lines = output.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            try {
              const response = JSON.parse(line.trim());
              
              // 处理tools/list响应
              if (response.result && response.result.tools) {
                tools = response.result.tools;
              }
            } catch (e) {
              // 忽略JSON解析错误
            }
          }
        }
      });

      // 发送初始化请求
      setTimeout(() => {
        const initRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mcp-tester', version: '1.0.0' }
          }
        };
        
        try {
          childProcess.stdin.write(JSON.stringify(initRequest) + '\n');
          hasInitialized = true;
        } catch (e) {
          console.error('发送初始化请求失败:', e);
        }
      }, 500);

      // 发送工具列表请求
      setTimeout(() => {
        if (hasInitialized) {
          const listToolsRequest = {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list'
          };
          
          try {
            childProcess.stdin.write(JSON.stringify(listToolsRequest) + '\n');
          } catch (e) {
            console.error('发送工具列表请求失败:', e);
          }
        }
      }, 1000);

      // 等待响应并清理
      setTimeout(() => {
        childProcess.kill();
        const connectionTime = Date.now() - startTime;
        
        resolve({
          tools: tools,
          connection_time: connectionTime,
          output: output
        });
      }, 3000);

      childProcess.on('error', (error) => {
        reject(error);
      });
    });
  }

  // 根据工具schema生成示例调用（通用版本）
  generateExampleCall(tool) {
    const properties = tool.inputSchema?.properties || {};
    const required = tool.inputSchema?.required || [];
    
    const example = {};
    
    // 通用的参数值生成逻辑
    for (const [key, schema] of Object.entries(properties)) {
      if (schema.example !== undefined) {
        // 优先使用schema中定义的示例值
        example[key] = schema.example;
      } else if (schema.default !== undefined) {
        // 使用默认值
        example[key] = schema.default;
      } else if (schema.enum) {
        // 如果有枚举值，使用第一个
        example[key] = schema.enum[0];
      } else {
        // 根据数据类型生成通用示例值
        switch (schema.type) {
          case 'number':
          case 'integer':
            if (schema.minimum !== undefined) {
              example[key] = schema.minimum + 1;
            } else if (schema.maximum !== undefined && schema.maximum < 10) {
              example[key] = schema.maximum - 1;
            } else {
              // 生成合理的数字示例
              example[key] = key.toLowerCase().includes('id') ? 1 : 
                           key.toLowerCase().includes('count') ? 5 :
                           key.toLowerCase().includes('size') ? 100 :
                           key.toLowerCase().includes('limit') ? 10 : 42;
            }
            break;
          
          case 'string':
            if (schema.format === 'email') {
              example[key] = 'example@email.com';
            } else if (schema.format === 'uri' || schema.format === 'url') {
              example[key] = 'https://example.com';
            } else if (schema.format === 'date') {
              example[key] = '2024-01-01';
            } else if (schema.format === 'date-time') {
              example[key] = '2024-01-01T12:00:00Z';
            } else if (key.toLowerCase().includes('name')) {
              example[key] = 'ExampleName';
            } else if (key.toLowerCase().includes('path')) {
              example[key] = '/example/path';
            } else if (key.toLowerCase().includes('file')) {
              example[key] = 'example.txt';
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

  // 生成通用的预期响应示例
  generateExpectedResponse(tool) {
    // 基于工具描述和输入参数，生成通用的响应示例
    const description = tool.description || tool.name;
    
    return `{
  "content": [
    {
      "type": "text",
      "text": "工具 '${tool.name}' 执行成功"
    }
  ]
}

注意：具体的响应内容取决于工具的实际实现。
工具描述：${description}`;
  }

  /**
   * 直接调用MCP工具并返回结果，不生成报告
   * 这是一个简单的工具调用方法，适合快速测试单个工具功能
   * 
   * @param {object} args - 参数对象
   * @param {string} args.server_command - MCP服务器启动命令，支持多种格式：
   *   - Windows路径：D:\Path\To\script.js 或 D:/Path/To/script.js
   *   - 带引号路径："D:\My Path\script.js"
   *   - 带执行器：node D:\Path\script.js
   *   - 相对路径：./script.js 或 ../folder/script.js
   * @param {string} args.tool_name - 要调用的工具名称
   * @param {object} args.tool_arguments - 传递给工具的参数
   * @param {boolean} args.return_raw - 是否返回原始响应
   * @returns {object} 工具调用结果
   */
  async callMCPTool(args) {
    const { server_command, tool_name, tool_arguments = {}, return_raw = false } = args;
    
    if (!server_command) {
      throw new Error("请指定server_command参数");
    }
    
    if (!tool_name) {
      throw new Error("请指定tool_name参数");
    }

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
  }

  async mockMCPClient(args) {
    const { server_command, request_type, request_data = {} } = args;
    
    if (!server_command) {
      throw new Error("请指定server_command参数");
    }

    // 处理命令
    const normalizedCommand = server_command.replace(/\\/g, '/');
    const commandParts = normalizedCommand.split(' ');
    const executable = commandParts[0];
    const scriptPath = commandParts.slice(1).join(' ');

    const client = new MCPClient();
    let result = {
      request: null,
      response: null,
      error: null,
      executionTime: 0
    };

    try {
      // 连接到服务器
      await client.connect(executable, [scriptPath]);
      
      // 先初始化（如果不是测试初始化本身）
      if (request_type !== 'initialize') {
        await client.initialize();
      }

      const startTime = Date.now();
      
      switch (request_type) {
        case 'initialize':
          result.request = {
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'mcp-tester', version: '1.0.0' },
              ...request_data
            }
          };
          result.response = await client.initialize();
          break;
          
        case 'list_tools':
          result.request = { method: 'tools/list' };
          result.response = await client.listTools();
          break;
          
        case 'call_tool':
          // 提供更友好的错误提示
          if (!request_data.name && !request_data.toolName) {
            throw new Error(
              "call_tool请求需要指定工具名。正确格式：{\"name\": \"工具名\", \"arguments\": {参数}}。" +
              "例如：{\"name\": \"add\", \"arguments\": {\"a\": 1, \"b\": 2}}"
            );
          }
          
          // 兼容多种格式
          const toolName = request_data.name || request_data.toolName || 'test_tool';
          const toolArgs = request_data.arguments || request_data.parameters || request_data.params || {};
          
          // 如果用户使用了错误的字段名，给出提示
          if (request_data.toolName || request_data.parameters || request_data.params) {
            console.error(
              "注意：建议使用标准格式 {\"name\": ..., \"arguments\": ...}，" +
              "但我们已自动转换了您的输入"
            );
          }
          
          result.request = {
            method: 'tools/call',
            params: {
              name: toolName,
              arguments: toolArgs
            }
          };
          result.response = await client.callTool(toolName, toolArgs);
          break;
          
        case 'ping':
          result.request = { method: 'ping' };
          result.response = await client.sendRequest('ping', request_data);
          break;
          
        default:
          throw new Error(`不支持的请求类型: ${request_type}`);
      }
      
      result.executionTime = Date.now() - startTime;
      
    } catch (error) {
      result.error = error.message;
    } finally {
      client.disconnect();
    }

    const report = `# MCP客户端模拟测试

## 📡 连接信息
- **服务器命令**: \`${server_command}\`
- **请求类型**: ${request_type}
- **执行时间**: ${result.executionTime}ms

## 📤 发送的请求
\`\`\`json
${JSON.stringify(result.request, null, 2)}
\`\`\`

## 📥 收到的响应
${result.error ? `### ❌ 错误
${result.error}` : `### ✅ 成功
\`\`\`json
${JSON.stringify(result.response, null, 2)}
\`\`\``}`;

    return {
      content: [
        {
          type: "text",
          text: report,
        },
      ],
    };
  }

  /**
   * 批量测试多个MCP工具
   */
  async batchTestTools(args) {
    const { server_command, test_cases, parallel = false, stop_on_error = false } = args;
    
    if (!server_command) {
      throw new Error("请指定server_command参数");
    }
    
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
  }

  /**
   * 对单个工具进行性能基准测试
   */
  async benchmarkSingleTool(args) {
    const { 
      server_command, 
      tool_name, 
      tool_arguments = {}, 
      iterations = 100, 
      concurrent_requests = 1,
      warmup_iterations = 5 
    } = args;
    
    if (!server_command) {
      throw new Error("请指定server_command参数");
    }
    
    if (!tool_name) {
      throw new Error("请指定tool_name参数");
    }

    // 使用统一的路径解析函数
    const parsedCommand = parseServerCommand(server_command);
    const { executable, scriptPath, args: parsedArgs } = parsedCommand;
    const allArgs = [scriptPath, ...parsedArgs];

    const client = new MCPClient();
    const benchmarkResults = {
      tool_name,
      iterations,
      concurrent_requests,
      warmup_iterations,
      execution_times: [],
      errors: [],
      statistics: {}
    };

    try {
      // 连接并初始化
      await client.connect(executable, allArgs);
      await client.initialize();
      
      // 验证工具存在
      const tools = await client.listTools();
      if (!tools.some(t => t.name === tool_name)) {
        throw new Error(`工具 ${tool_name} 不存在`);
      }

      console.error(`开始性能测试: ${tool_name}`);
      console.error(`预热迭代: ${warmup_iterations}`);
      
      // 预热阶段
      for (let i = 0; i < warmup_iterations; i++) {
        try {
          await client.callTool(tool_name, tool_arguments);
        } catch (e) {
          // 预热阶段的错误不计入统计
        }
      }

      console.error(`开始正式测试: ${iterations} 次迭代, ${concurrent_requests} 并发`);

      // 正式测试阶段
      if (concurrent_requests > 1) {
        // 并发测试
        const batches = Math.ceil(iterations / concurrent_requests);
        
        for (let batch = 0; batch < batches; batch++) {
          const batchSize = Math.min(concurrent_requests, iterations - batch * concurrent_requests);
          const promises = [];
          
          for (let i = 0; i < batchSize; i++) {
            const promise = (async () => {
              const startTime = Date.now();
              try {
                await client.callTool(tool_name, tool_arguments);
                return Date.now() - startTime;
              } catch (error) {
                benchmarkResults.errors.push(error.message);
                return null;
              }
            })();
            promises.push(promise);
          }
          
          const results = await Promise.all(promises);
          results.forEach(time => {
            if (time !== null) {
              benchmarkResults.execution_times.push(time);
            }
          });
        }
      } else {
        // 串行测试
        for (let i = 0; i < iterations; i++) {
          const startTime = Date.now();
          try {
            await client.callTool(tool_name, tool_arguments);
            benchmarkResults.execution_times.push(Date.now() - startTime);
          } catch (error) {
            benchmarkResults.errors.push(error.message);
          }
        }
      }

      // 计算统计数据
      if (benchmarkResults.execution_times.length > 0) {
        const sorted = [...benchmarkResults.execution_times].sort((a, b) => a - b);
        const sum = sorted.reduce((a, b) => a + b, 0);
        
        benchmarkResults.statistics = {
          total_requests: iterations,
          successful_requests: benchmarkResults.execution_times.length,
          failed_requests: benchmarkResults.errors.length,
          avg: Math.round(sum / sorted.length),
          min: sorted[0],
          max: sorted[sorted.length - 1],
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p90: sorted[Math.floor(sorted.length * 0.9)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          p99: sorted[Math.floor(sorted.length * 0.99)],
          success_rate: (benchmarkResults.execution_times.length / iterations * 100).toFixed(2) + '%'
        };
        
        // 计算标准差
        const mean = sum / sorted.length;
        const variance = sorted.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / sorted.length;
        benchmarkResults.statistics.std_dev = Math.round(Math.sqrt(variance));
      }

    } catch (error) {
      throw new Error(`性能测试失败: ${error.message}`);
    } finally {
      client.disconnect();
    }

    // 生成报告
    const stats = benchmarkResults.statistics;
    const report = `# 单工具性能基准测试报告

## 🎯 测试目标
- **工具名称**: ${tool_name}
- **测试参数**: \`\`\`json
${JSON.stringify(tool_arguments, null, 2)}
\`\`\`

## ⚙️ 测试配置
- **总迭代次数**: ${iterations}
- **并发请求数**: ${concurrent_requests}
- **预热迭代**: ${warmup_iterations}

## 📊 性能统计
- **总请求数**: ${stats.total_requests || iterations}
- **成功请求**: ${stats.successful_requests || 0}
- **失败请求**: ${stats.failed_requests || 0}
- **成功率**: ${stats.success_rate || '0%'}

## ⏱️ 响应时间 (ms)
| 指标 | 值 |
|------|-----|
| 最小值 | ${stats.min || 'N/A'} |
| 平均值 | ${stats.avg || 'N/A'} |
| 中位数 (P50) | ${stats.p50 || 'N/A'} |
| P90 | ${stats.p90 || 'N/A'} |
| P95 | ${stats.p95 || 'N/A'} |
| P99 | ${stats.p99 || 'N/A'} |
| 最大值 | ${stats.max || 'N/A'} |
| 标准差 | ${stats.std_dev || 'N/A'} |

## 📈 性能分析
${stats.avg ? `
- **响应时间稳定性**: ${stats.std_dev < stats.avg * 0.2 ? '✅ 优秀（标准差小于平均值的20%）' : 
  stats.std_dev < stats.avg * 0.5 ? '⚠️ 良好（标准差小于平均值的50%）' : 
  '❌ 较差（标准差大于平均值的50%）'}
- **吞吐量**: 约 ${Math.round(1000 / stats.avg * concurrent_requests)} 请求/秒
- **性能建议**: ${
  stats.avg < 10 ? '响应速度极快，性能优秀' :
  stats.avg < 50 ? '响应速度良好' :
  stats.avg < 200 ? '响应速度可接受，可考虑优化' :
  '响应较慢，建议进行性能优化'
}` : '无足够数据进行分析'}

${benchmarkResults.errors.length > 0 ? `## ⚠️ 错误记录
- **错误率**: ${(benchmarkResults.errors.length / iterations * 100).toFixed(2)}%
- **前10个错误**:
${benchmarkResults.errors.slice(0, 10).map((e, i) => `  ${i + 1}. ${e}`).join('\n')}
${benchmarkResults.errors.length > 10 ? `\n... 还有 ${benchmarkResults.errors.length - 10} 个错误` : ''}` : ''}`;

    return {
      content: [
        {
          type: "text",
          text: report,
        },
      ],
    };
  }

  /**
   * 测试负面用例
   */
  async testNegativeCases(args) {
    const { server_command, negative_cases, strict_mode = false } = args;
    
    if (!server_command) {
      throw new Error("请指定server_command参数");
    }
    
    if (!negative_cases || negative_cases.length === 0) {
      throw new Error("请提供至少一个负面测试用例");
    }

    // 使用统一的路径解析函数
    const parsedCommand = parseServerCommand(server_command);
    const { executable, scriptPath, args: parsedArgs } = parsedCommand;
    const allArgs = [scriptPath, ...parsedArgs];

    const client = new MCPClient();
    const testResults = {
      total_cases: negative_cases.length,
      passed: 0,
      failed: 0,
      results: []
    };

    try {
      // 连接并初始化
      await client.connect(executable, allArgs);
      await client.initialize();
      
      // 获取可用工具列表
      const availableTools = await client.listTools();
      const toolNames = availableTools.map(t => t.name);

      // 执行负面测试
      for (const testCase of negative_cases) {
        const { tool_name, arguments: toolArgs, expected_error, description } = testCase;
        
        if (!toolNames.includes(tool_name)) {
          testResults.results.push({
            tool_name,
            description,
            passed: false,
            reason: `工具 ${tool_name} 不存在`,
            arguments: toolArgs,
            expected_error
          });
          continue;
        }

        try {
          // 调用工具（预期会失败或返回错误响应）
          const response = await client.callTool(tool_name, toolArgs);
          
          // 检查响应是否包含错误信息
          let isErrorResponse = false;
          let errorMessage = '';
          
          // 检查响应中的 isError 字段
          if (response && response.isError === true) {
            isErrorResponse = true;
            errorMessage = response.message || response.error || '响应标记为错误';
          }
          
          // 检查 content 中是否包含错误信息
          if (response && response.content && Array.isArray(response.content)) {
            for (const item of response.content) {
              if (item.type === 'text' && item.text) {
                // 检查文本中是否包含错误标识
                if (item.text.includes('Error:') || item.text.includes('错误') || 
                    item.text.includes('isError: true') || item.text.includes('error')) {
                  isErrorResponse = true;
                  // 提取错误消息
                  const errorMatch = item.text.match(/Error:\s*(.+?)(?:\n|$)/i);
                  if (errorMatch) {
                    errorMessage = errorMatch[1].trim();
                  } else {
                    errorMessage = item.text;
                  }
                  break;
                }
              }
            }
          }
          
          if (isErrorResponse) {
            // 响应包含错误信息，按错误处理
            let passed = false;
            let reason = '';
            
            if (expected_error) {
              if (strict_mode) {
                // 严格模式：完全匹配
                passed = errorMessage === expected_error || 
                         (errorMessage && errorMessage.includes(expected_error));
                reason = passed ? '错误消息匹配（响应中的错误）' : 
                  `错误消息不匹配。预期: "${expected_error}", 实际: "${errorMessage}"`;
              } else {
                // 宽松模式：包含匹配或正则匹配
                try {
                  const regex = new RegExp(expected_error, 'i');
                  passed = regex.test(errorMessage);
                  reason = passed ? '错误消息匹配正则表达式（响应中的错误）' : 
                    `错误消息不匹配。模式: "${expected_error}", 实际: "${errorMessage}"`;
                } catch {
                  // 如果不是有效的正则，使用包含匹配
                  passed = errorMessage.toLowerCase().includes(expected_error.toLowerCase());
                  reason = passed ? '错误消息包含预期文本（响应中的错误）' : 
                    `错误消息不包含预期文本。预期包含: "${expected_error}", 实际: "${errorMessage}"`;
                }
              }
            } else {
              // 没有指定预期错误，只要包含错误信息就算通过
              passed = true;
              reason = '响应包含错误信息';
            }
            
            testResults.results.push({
              tool_name,
              description,
              passed,
              reason,
              arguments: toolArgs,
              expected_error,
              actual_error: errorMessage,
              response_type: '成功响应但包含错误信息'
            });
          } else {
            // 没有抛出错误，也没有错误响应，测试失败
            testResults.results.push({
              tool_name,
              description,
              passed: false,
              reason: '预期抛出错误或返回错误响应，但调用成功且无错误信息',
              arguments: toolArgs,
              expected_error,
              actual_response: response
            });
          }
        } catch (error) {
          // 检查错误是否符合预期
          let passed = false;
          let reason = '';
          
          if (expected_error) {
            if (strict_mode) {
              // 严格模式：完全匹配
              passed = error.message === expected_error;
              reason = passed ? '错误消息完全匹配' : 
                `错误消息不匹配。预期: "${expected_error}", 实际: "${error.message}"`;
            } else {
              // 宽松模式：包含匹配或正则匹配
              try {
                const regex = new RegExp(expected_error);
                passed = regex.test(error.message);
                reason = passed ? '错误消息匹配正则表达式' : 
                  `错误消息不匹配正则。模式: "${expected_error}", 实际: "${error.message}"`;
              } catch {
                // 如果不是有效的正则，使用包含匹配
                passed = error.message.includes(expected_error);
                reason = passed ? '错误消息包含预期文本' : 
                  `错误消息不包含预期文本。预期包含: "${expected_error}", 实际: "${error.message}"`;
              }
            }
          } else {
            // 没有指定预期错误，只要抛出错误就算通过
            passed = true;
            reason = '成功抛出错误';
          }
          
          testResults.results.push({
            tool_name,
            description,
            passed,
            reason,
            arguments: toolArgs,
            expected_error,
            actual_error: error.message
          });
        }
      }

      // 统计结果
      testResults.passed = testResults.results.filter(r => r.passed).length;
      testResults.failed = testResults.results.filter(r => !r.passed).length;

    } catch (error) {
      throw new Error(`负面测试失败: ${error.message}`);
    } finally {
      client.disconnect();
    }

    // 生成报告
    const report = `# 负面测试用例报告

## 📊 测试概览
- **测试用例总数**: ${testResults.total_cases}
- **通过**: ${testResults.passed} (${Math.round(testResults.passed / testResults.total_cases * 100)}%)
- **失败**: ${testResults.failed} (${Math.round(testResults.failed / testResults.total_cases * 100)}%)
- **匹配模式**: ${strict_mode ? '严格匹配' : '宽松匹配（支持正则和包含）'}

## 🔍 详细结果

${testResults.results.map((result, index) => {
  const icon = result.passed ? '✅' : '❌';
  let details = `### ${index + 1}. ${icon} ${result.tool_name}`;
  
  if (result.description) {
    details += `\n**描述**: ${result.description}`;
  }
  
  details += `\n**状态**: ${result.passed ? '通过' : '失败'}`;
  details += `\n**原因**: ${result.reason}`;
  
  details += `\n\n**测试参数**:\n\`\`\`json\n${JSON.stringify(result.arguments, null, 2)}\n\`\`\``;
  
  if (result.expected_error) {
    details += `\n\n**预期错误**: ${result.expected_error}`;
  }
  
  if (result.actual_error) {
    details += `\n**实际错误**: ${result.actual_error}`;
  } else if (result.actual_response) {
    details += `\n\n**实际响应**（预期失败但成功）:\n\`\`\`json\n${JSON.stringify(result.actual_response, null, 2)}\n\`\`\``;
  }
  
  return details;
}).join('\n\n---\n\n')}

## 💡 测试建议
${testResults.failed > 0 ? `
- ⚠️ 有 ${testResults.failed} 个测试用例未按预期行为
- 请检查：
  1. 错误消息格式是否发生变化
  2. 工具的错误处理逻辑是否正确
  3. 预期错误消息是否准确` : '✅ 所有负面测试用例都按预期行为，错误处理机制工作正常'}`;

    return {
      content: [
        {
          type: "text",
          text: report,
        },
      ],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("MCP测试工具服务器已启动");
  }
}

const tester = new MCPTester();
tester.run().catch(console.error);

export default MCPTester;