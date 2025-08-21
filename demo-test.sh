#!/bin/bash

# MCPTester功能演示脚本

echo "=========================================="
echo "MCPTester 功能演示"
echo "=========================================="
echo ""

# 启动测试服务器
echo "1. 启动测试MCP服务器..."
node test-example.js 2>/dev/null &
SERVER_PID=$!
sleep 2

echo "   服务器已启动 (PID: $SERVER_PID)"
echo ""

# 测试基本功能
echo "2. 测试基本连接..."
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"name":"test_mcp_server","arguments":{"server_command":"node test-example.js","timeout":5}}}' | node index.js 2>/dev/null | head -20
echo ""

echo "3. 验证add工具..."
echo "   这将显示完整的请求参数和响应结果："
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"validate_mcp_tools","arguments":{"server_command":"node test-example.js","tool_name":"add"}}}' | node index.js 2>/dev/null | grep -A 20 "请求参数"
echo ""

# 清理
echo "4. 清理..."
kill $SERVER_PID 2>/dev/null
echo "   测试服务器已停止"
echo ""

echo "=========================================="
echo "演示完成！"
echo "现在你可以看到MCPTester会显示："
echo "- 实际发送的请求参数"
echo "- 实际收到的响应结果"
echo "- 测试是真实执行的，不是模拟的"
echo "=========================================="