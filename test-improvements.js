#!/usr/bin/env node

// 演示MCPTester改进后的功能

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

console.log("==========================================");
console.log("MCPTester 改进功能演示");
console.log("==========================================");
console.log("");

async function sendRequest(tester, request) {
  return new Promise((resolve) => {
    let output = '';
    
    // 收集输出
    const dataHandler = (data) => {
      output += data.toString();
    };
    tester.stdout.on('data', dataHandler);
    
    // 发送请求
    tester.stdin.write(JSON.stringify(request) + '\n');
    
    // 等待响应
    setTimeout(3000).then(() => {
      tester.stdout.off('data', dataHandler);
      resolve(output);
    });
  });
}

async function runDemo() {
  // 1. 启动测试服务器
  console.log("1. 启动测试MCP服务器...");
  const testServer = spawn('node', ['test-example.js'], { 
    stdio: 'pipe',
    shell: process.platform === 'win32'
  });
  
  await setTimeout(2000);
  console.log("   服务器已启动\n");

  // 2. 启动MCPTester
  const tester = spawn('node', ['index.js'], { 
    stdio: 'pipe',
    shell: process.platform === 'win32'
  });
  
  await setTimeout(2000);

  // 演示1: validate_mcp_tools 使用自定义参数
  console.log("==========================================");
  console.log("演示1: validate_mcp_tools 使用自定义参数");
  console.log("==========================================\n");
  
  console.log("测试场景：验证add工具，使用自定义参数 {a: 100, b: 200}");
  console.log("（之前的问题：总是使用默认的 {a: 42, b: 42}）\n");
  
  const validateRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "validate_mcp_tools",
      arguments: {
        server_command: "node test-example.js",
        tool_name: "add",
        test_params: {
          a: 100,
          b: 200
        }
      }
    }
  };
  
  console.log("发送的请求：");
  console.log(JSON.stringify(validateRequest.params.arguments, null, 2));
  console.log("");
  
  const validateOutput = await sendRequest(tester, validateRequest);
  
  // 解析并显示结果
  try {
    const lines = validateOutput.split('\n');
    const responseLine = lines.find(line => line.includes('"result"'));
    if (responseLine) {
      const response = JSON.parse(responseLine);
      const text = response.result.content[0].text;
      
      // 提取请求参数部分
      const requestMatch = text.match(/请求参数:\s*```json\s*([\s\S]*?)```/);
      if (requestMatch) {
        console.log("✅ 实际使用的测试参数：");
        console.log(requestMatch[1].trim());
        console.log("");
        
        // 验证参数是否正确
        const actualParams = JSON.parse(requestMatch[1].trim());
        if (actualParams.a === 100 && actualParams.b === 200) {
          console.log("✅ 成功！工具正确使用了自定义参数！\n");
        } else {
          console.log("❌ 参数不匹配\n");
        }
      }
      
      // 提取响应部分
      const responseMatch = text.match(/实际响应:\s*```json\s*([\s\S]*?)```/);
      if (responseMatch) {
        console.log("📥 工具响应：");
        console.log(responseMatch[1].trim());
        console.log("");
      }
    }
  } catch (e) {
    console.log("输出解析失败");
  }
  
  await setTimeout(2000);
  
  // 演示2: mock_mcp_client 改进的错误提示
  console.log("\n==========================================");
  console.log("演示2: mock_mcp_client 改进的参数格式支持");
  console.log("==========================================\n");
  
  console.log("测试场景：调用greet工具");
  console.log("支持多种参数格式，并提供清晰的错误提示\n");
  
  // 正确格式
  const mockRequest1 = {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "mock_mcp_client",
      arguments: {
        server_command: "node test-example.js",
        request_type: "call_tool",
        request_data: {
          name: "greet",
          arguments: {
            name: "Alice",
            language: "zh"
          }
        }
      }
    }
  };
  
  console.log("使用标准格式 {name: ..., arguments: ...}：");
  const mockOutput1 = await sendRequest(tester, mockRequest1);
  
  try {
    const lines = mockOutput1.split('\n');
    const responseLine = lines.find(line => line.includes('"result"'));
    if (responseLine) {
      const response = JSON.parse(responseLine);
      const text = response.result.content[0].text;
      
      // 检查是否包含中文问候
      if (text.includes("你好，Alice")) {
        console.log("✅ 成功调用！收到响应：你好，Alice！\n");
      }
    }
  } catch (e) {
    console.log("响应解析失败");
  }
  
  await setTimeout(2000);
  
  // 兼容格式（使用toolName和parameters）
  const mockRequest2 = {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "mock_mcp_client",
      arguments: {
        server_command: "node test-example.js",
        request_type: "call_tool",
        request_data: {
          toolName: "greet",  // 使用toolName而不是name
          parameters: {        // 使用parameters而不是arguments
            name: "Bob",
            language: "en"
          }
        }
      }
    }
  };
  
  console.log("使用兼容格式 {toolName: ..., parameters: ...}：");
  console.log("（工具会自动转换并给出提示）");
  const mockOutput2 = await sendRequest(tester, mockRequest2);
  
  try {
    const lines = mockOutput2.split('\n');
    const responseLine = lines.find(line => line.includes('"result"'));
    if (responseLine) {
      const response = JSON.parse(responseLine);
      const text = response.result.content[0].text;
      
      if (text.includes("Hello, Bob")) {
        console.log("✅ 兼容格式也能正常工作！收到响应：Hello, Bob!\n");
      }
    }
  } catch (e) {
    console.log("响应解析失败");
  }
  
  console.log("\n==========================================");
  console.log("改进总结");
  console.log("==========================================\n");
  
  console.log("✅ validate_mcp_tools 现在正确使用自定义test_params");
  console.log("   - 测试单个工具时，直接传递参数");
  console.log("   - 测试多个工具时，使用对象格式\n");
  
  console.log("✅ mock_mcp_client 提供更好的用户体验");
  console.log("   - 清晰的参数格式说明和示例");
  console.log("   - 兼容多种参数格式（name/toolName, arguments/parameters）");
  console.log("   - 友好的错误提示\n");
  
  console.log("==========================================");
  
  // 清理
  tester.kill();
  testServer.kill();
  
  process.exit(0);
}

runDemo().catch(console.error);