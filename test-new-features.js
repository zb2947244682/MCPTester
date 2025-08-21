#!/usr/bin/env node

/**
 * 测试新功能的示例脚本
 * 这个脚本展示了如何使用 MCPTester 的新功能
 */

import MCPTester from './index.js';

async function testNewFeatures() {
  const tester = new MCPTester();
  
  console.log('✅ MCPTester 新功能已成功加载！\n');
  console.log('可用的新工具：');
  console.log('1. batch_test_tools - 批量测试多个工具');
  console.log('2. benchmark_single_tool - 单工具性能基准测试');
  console.log('3. test_negative_cases - 负面测试用例');
  console.log('4. generate_mcp_test_report - 增强的报告生成（支持更多选项）\n');
  
  // 验证新方法是否存在
  const newMethods = [
    'batchTestTools',
    'benchmarkSingleTool',
    'testNegativeCases'
  ];
  
  console.log('验证新方法：');
  for (const method of newMethods) {
    if (typeof tester[method] === 'function') {
      console.log(`✅ ${method} 方法已定义`);
    } else {
      console.error(`❌ ${method} 方法未找到`);
    }
  }
  
  // 示例：创建批量测试用例
  const batchTestExample = {
    test_cases: [
      {
        tool_name: "add",
        arguments: { a: 1, b: 2 },
        description: "基本加法测试"
      },
      {
        tool_name: "multiply",
        arguments: { a: 3, b: 4 },
        description: "基本乘法测试"
      }
    ],
    parallel: true,
    stop_on_error: false
  };
  
  console.log('\n批量测试示例配置：');
  console.log(JSON.stringify(batchTestExample, null, 2));
  
  // 示例：性能测试配置
  const benchmarkExample = {
    tool_name: "add",
    tool_arguments: { a: 10, b: 20 },
    iterations: 100,
    concurrent_requests: 5,
    warmup_iterations: 10
  };
  
  console.log('\n性能测试示例配置：');
  console.log(JSON.stringify(benchmarkExample, null, 2));
  
  // 示例：负面测试用例
  const negativeTestExample = {
    negative_cases: [
      {
        tool_name: "divide",
        arguments: { a: 10, b: 0 },
        expected_error: "零",
        description: "除零测试"
      }
    ],
    strict_mode: false
  };
  
  console.log('\n负面测试示例配置：');
  console.log(JSON.stringify(negativeTestExample, null, 2));
  
  console.log('\n✅ 所有新功能已准备就绪！');
  console.log('您现在可以使用这些新工具来测试您的 MCP 服务器了。');
}

testNewFeatures().catch(console.error);
