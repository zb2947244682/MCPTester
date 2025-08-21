# MCPTester Bug 修复报告

## 🐛 已修复的问题

### 1. ✅ test_negative_cases 增强错误识别能力

**问题描述：**
- 原本只能识别抛出异常的错误
- 无法识别"成功响应但包含错误信息"的情况（如返回 `isError: true` 或 content 中包含 "Error:" 的响应）

**修复内容：**
- 增加了对响应内容的智能检测
- 现在能识别以下几种错误模式：
  1. **传统异常抛出**：`throw new Error()`
  2. **响应中的 isError 字段**：`{ isError: true, message: "..." }`  
  3. **content 中的错误文本**：检测 "Error:", "错误", "isError: true" 等关键词
  4. **灵活的错误消息提取**：自动从响应中提取错误消息

**新增功能：**
- 支持不区分大小写的匹配
- 增加了 `response_type` 字段标识错误类型
- 更友好的错误消息比对

**使用示例：**
```json
{
  "negative_cases": [{
    "tool_name": "divide",
    "arguments": {"a": 10, "b": 0},
    "expected_error": "Division by zero",
    "description": "测试除零错误"
  }]
}
```

现在即使工具返回这样的响应也能正确识别：
```json
{
  "content": [{
    "type": "text",
    "text": "Error: Division by zero\nisError: true"
  }]
}
```

### 2. ✅ generate_mcp_test_report 路径处理优化

**问题描述：**
- 错误地拼接用户工作目录和绝对路径
- 路径中出现多余的引号
- 没有正确处理 output_file 参数的优先级

**修复内容：**
1. **路径优先级修正**：
   - 优先使用用户提供的 `output_file`
   - 其次基于目标文件生成默认路径
   - 最后使用默认文件名

2. **路径处理改进**：
   - 自动去除路径两端的引号
   - 正确处理绝对路径和相对路径
   - 使用统一的路径解析函数 `parseServerCommand`

3. **新增多格式支持**：
   - 支持 JSON 格式输出
   - 支持 HTML 格式输出（带样式）
   - 根据格式自动添加正确的文件扩展名

**增强功能：**
- **tools_filter**: 只测试和报告特定工具
- **test_tools**: 控制是否实际测试（false只生成静态报告）
- **include_performance**: 是否包含性能测试
- **output_format**: 支持 markdown/json/html 三种格式

**使用示例：**
```json
{
  "server_command": "node D:\\Path\\To\\tool.js",
  "output_file": "D:\\Reports\\my_report",
  "output_format": "json",
  "tools_filter": ["add", "multiply"],
  "test_tools": true
}
```

## 🔧 技术改进

### 统一的路径处理
- 所有涉及路径的地方都使用 `parseServerCommand` 函数
- 支持 Windows 反斜杠、Unix 正斜杠、带空格路径等各种格式
- 自动处理引号和空格

### 更智能的错误检测
- 使用多种策略检测错误响应
- 支持正则表达式匹配
- 不区分大小写的文本匹配

### 灵活的报告生成
- 三种输出格式满足不同需求
- 可过滤特定工具
- 可选的性能测试集成

## 📝 测试建议

### 测试负面用例修复：
```json
{
  "server_command": "node calculator.js",
  "negative_cases": [{
    "tool_name": "divide",
    "arguments": {"a": 10, "b": 0},
    "expected_error": "zero"
  }]
}
```

### 测试报告生成修复：
```json
{
  "server_command": "node calculator.js",
  "output_file": "D:\\MyReports\\test_report",
  "output_format": "json"
}
```

## ✨ 总结

这两个修复大大提升了 MCPTester 的健壮性和易用性：

1. **更智能的错误检测**：能够识别各种形式的错误响应
2. **更可靠的路径处理**：正确处理各种路径格式和用户输入
3. **更丰富的功能选项**：支持多种输出格式和过滤选项

所有修复都已完成并集成到代码中，可以立即使用！