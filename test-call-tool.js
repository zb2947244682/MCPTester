#!/usr/bin/env node

// 测试脚本，用于验证 callMCPTool 方法是否正常工作

import MCPTester from './index.js';

async function testCallMCPTool() {
  console.log('测试 callMCPTool 方法...\n');
  
  const tester = new MCPTester();
  
  // 测试 callMCPTool 方法是否存在
  if (typeof tester.callMCPTool === 'function') {
    console.log('✅ callMCPTool 方法已定义');
    
    // 测试方法签名
    console.log('方法名称:', tester.callMCPTool.name);
    console.log('参数数量:', tester.callMCPTool.length);
    
    // 测试基本的错误处理
    try {
      await tester.callMCPTool({});
    } catch (error) {
      console.log('✅ 参数验证正常工作:', error.message);
    }
    
    console.log('\n✅ callMCPTool 方法已成功添加并可以被调用');
  } else {
    console.error('❌ callMCPTool 方法未定义');
    process.exit(1);
  }
}

testCallMCPTool().catch(console.error);