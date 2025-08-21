#!/usr/bin/env node

import MCPTester from './index.js';

async function testServer() {
  console.log('创建MCPTester实例...');
  const tester = new MCPTester();
  
  // 检查setupToolHandlers是否正常
  console.log('检查setupToolHandlers方法:', typeof tester.setupToolHandlers);
  
  // 检查server对象
  console.log('检查server对象:', tester.server ? '存在' : '不存在');
  
  // 尝试手动获取工具列表
  try {
    const { ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const handler = tester.server._requestHandlers.get(ListToolsRequestSchema.method);
    
    if (handler) {
      console.log('找到工具列表处理器');
      const result = await handler({});
      console.log('工具数量:', result.tools ? result.tools.length : 0);
      if (result.tools && result.tools.length > 0) {
        console.log('前5个工具:');
        result.tools.slice(0, 5).forEach(tool => {
          console.log(' -', tool.name);
        });
      }
    } else {
      console.log('未找到工具列表处理器');
    }
  } catch (error) {
    console.error('错误:', error.message);
  }
}

testServer().catch(console.error);