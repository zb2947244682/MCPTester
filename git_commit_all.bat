@echo off
chcp 65001 >nul
echo 开始批量处理所有git仓库...

echo.
echo ========================================
echo 处理 mcp-calculator 仓库
echo ========================================
cd mcp-calculator
if exist .git (
    echo 执行 git add .
    git add .
    echo 执行 git commit -m "暂无"
    git commit -m "暂无"
    echo 执行 git push
    git push
    echo mcp-calculator 完成
) else (
    echo mcp-calculator 不是git仓库，跳过
)
cd ..

echo.
echo ========================================
echo 处理 mcp-context 仓库
echo ========================================
cd mcp-context
if exist .git (
    echo 执行 git add .
    git add .
    echo 执行 git commit -m "暂无"
    git commit -m "暂无"
    echo 执行 git push
    git push
    echo mcp-context 完成
) else (
    echo mcp-context 不是git仓库，跳过
)
cd ..

echo.
echo ========================================
echo 处理 mcp-http-requester 仓库
echo ========================================
cd mcp-http-requester
if exist .git (
    echo 执行 git add .
    git add .
    echo 执行 git commit -m "暂无"
    git commit -m "暂无"
    echo 执行 git push
    git push
    echo mcp-http-requester 完成
) else (
    echo mcp-http-requester 不是git仓库，跳过
)
cd ..

echo.
echo ========================================
echo 处理 mcp-mssql 仓库
echo ========================================
cd mcp-mssql
if exist .git (
    echo 执行 git add .
    git add .
    echo 执行 git commit -m "暂无"
    git commit -m "暂无"
    echo 执行 git push
    git push
    echo mcp-mssql 完成
) else (
    echo mcp-mssql 不是git仓库，跳过
)
cd ..

echo.
echo ========================================
echo 处理 mcp-ssh 仓库
echo ========================================
cd mcp-ssh
if exist .git (
    echo 执行 git add .
    git add .
    echo 执行 git commit -m "暂无"
    git commit -m "暂无"
    echo 执行 git push
    git push
    echo mcp-ssh 完成
) else (
    echo mcp-ssh 不是git仓库，跳过
)
cd ..

echo.
echo ========================================
echo 处理 mcp-tester 仓库
echo ========================================
cd mcp-tester
if exist .git (
    echo 执行 git add .
    git add .
    echo 执行 git commit -m "暂无"
    git commit -m "暂无"
    echo 执行 git push
    git push
    echo mcp-tester 完成
) else (
    echo mcp-tester 不是git仓库，跳过
)
cd ..

echo.
echo ========================================
echo 所有仓库处理完成！
echo ========================================
pause
