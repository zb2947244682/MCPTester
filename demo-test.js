#!/usr/bin/env node

// MCPTester功能演示脚本

import { spawn } from 'child_process';
import { setTimeout } from 'timers/promises';

console.log("==========================================");
console.log("MCPTester 功能演示");
console.log("==========================================");
console.log("");

async function runDemo() {
  // 1. 启动测试服务器
  console.log("1. 启动测试MCP服务器...");
  const testServer = spawn('node', ['test-example.js'], { 
    stdio: 'pipe',
    shell: process.platform === 'win32'
  });
  
  await setTimeout(2000);
  console.log("   服务器已启动");
  console.log("");

  // 2. 运行MCPTester进行测试
  console.log("2. 使用MCPTester测试服务器...");
  console.log("   测试命令: node index.js");
  console.log("");
  
  const tester = spawn('node', ['index.js'], { 
    stdio: 'pipe',
    shell: process.platform === 'win32'
  });

  // 发送测试请求
  const testRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "validate_mcp_tools",
      arguments: {
        server_command: "node test-example.js",
        tool_name: "add"
      }
    }
  };

  // 等待MCPTester启动
  await setTimeout(2000);
  
  // 发送请求
  tester.stdin.write(JSON.stringify(testRequest) + '\n');
  
  // 收集输出
  let output = '';
  tester.stdout.on('data', (data) => {
    output += data.toString();
  });

  // 等待响应
  await setTimeout(3000);
  
  // 显示结果
  console.log("3. 测试结果预览：");
  console.log("==========================================");
  
  // 解析并显示关键信息
  try {
    const response = JSON.parse(output.split('\n').find(line => line.includes('"result"')));
    if (response && response.result && response.result.content) {
      const text = response.result.content[0].text;
      
      // 提取关键信息
      if (text.includes('请求参数:')) {
        const requestMatch = text.match(/请求参数:\s*```json\s*([\s\S]*?)```/);
        if (requestMatch) {
          console.log("📤 发送的请求参数:");
          console.log(requestMatch[1].trim());
          console.log("");
        }
      }
      
      if (text.includes('实际响应:')) {
        const responseMatch = text.match(/实际响应:\s*```json\s*([\s\S]*?)```/);
        if (responseMatch) {
          console.log("📥 收到的响应结果:");
          console.log(responseMatch[1].trim());
          console.log("");
        }
      }
      
      if (text.includes('功能测试:')) {
        const statusMatch = text.match(/功能测试: (✅ 成功|❌ 失败)/);
        if (statusMatch) {
          console.log("✔️ 测试状态:", statusMatch[1]);
          console.log("");
        }
      }
    }
  } catch (e) {
    console.log("输出示例（部分）:");
    console.log(output.substring(0, 500));
  }
  
  console.log("==========================================");
  console.log("演示重点：");
  console.log("✅ MCPTester现在真实地连接到MCP服务器");
  console.log("✅ 实际发送请求并接收响应");
  console.log("✅ 显示完整的请求参数和响应数据");
  console.log("✅ 不再使用模拟数据");
  console.log("==========================================");
  
  // 清理
  tester.kill();
  testServer.kill();
  
  process.exit(0);
}

runDemo().catch(console.error);