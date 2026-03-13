package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"code.byted.org/iaasng/lumi-cua-go-sdk/src/lumi_cua_sdk"
)

// ─── 配置 ─────────────────────────────────────────────────
// 所有敏感/可变配置通过环境变量注入（由上层 task_runner.js 从 .env 加载）

const (
	defaultManagerURL = "https://iaas-cua-devbox-ecs-manager-v2.byted.org/mgr"
	defaultPlannerURL = "https://iaas-cua-devbox-planner-agent.byted.org/planner"

	taskTimeoutSeconds = 300
	idlePollInterval   = 5 * time.Second
	maxIdleWaitTime    = 90 * time.Second
)

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envRequired(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("❌ 缺少必需的环境变量: %s（请在项目根目录 .env 中配置）", key)
	}
	return v
}

func main() {
	if len(os.Args) < 3 {
		log.Fatalf("Usage: %s <taskListFile> <projectDir>", os.Args[0])
	}
	taskListFile := os.Args[1]
	projectDir := os.Args[2]

	// ── 从环境变量读取配置（由 task_runner.js 透传 process.env） ──
	managerURL := envOrDefault("LUMI_MANAGER_URL", defaultManagerURL)
	plannerURL := envOrDefault("LUMI_PLANNER_URL", defaultPlannerURL)
	apiKey := envRequired("LUMI_API_KEY")

	// ── 读取任务列表 ──
	taskBytes, err := os.ReadFile(taskListFile)
	if err != nil {
		log.Fatalf("❌ 无法读取任务文件 %s: %v", taskListFile, err)
	}
	taskPrompt := strings.TrimSpace(string(taskBytes))
	if taskPrompt == "" {
		log.Fatalf("❌ 任务文件为空: %s", taskListFile)
	}

	// ── 初始化 Lumi CUA 客户端 ──
	client := lumi_cua_sdk.NewLumiCuaClient(managerURL, plannerURL, apiKey)
	ctx := context.Background()

	// ── 获取沙箱 ──
	sandbox, err := getAvailableSandbox(ctx, client)
	if err != nil {
		log.Fatalf("❌ %v", err)
	}
	fmt.Printf("🖥️  使用沙箱: ID=%s, IP=%s\n", sandbox.ID(), sandbox.IPAddress())

	// ── 等待 Planner 空闲 ──
	if err := waitForIdle(ctx, client, sandbox.ID()); err != nil {
		log.Fatalf("❌ %v", err)
	}

	// ── 选择模型 ──
	model, err := selectModel(ctx, client, sandbox.ID())
	if err != nil {
		log.Fatalf("❌ %v", err)
	}
	fmt.Printf("🤖 使用模型: %s\n", model)

	// ── 执行任务 ──
	fmt.Println("\n🚀 开始执行远程任务...")
	if err := runTask(ctx, client, taskPrompt, sandbox.ID(), model); err != nil {
		log.Printf("⚠️  任务执行异常: %v", err)
	}

	// ── 保存最终截图 ──
	saveScreenshot(ctx, sandbox, projectDir)
}

// ─── 沙箱管理 ─────────────────────────────────────────────

func getAvailableSandbox(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient) (*lumi_cua_sdk.Sandbox, error) {
	sandboxes, err := client.ListSandboxes(ctx)
	if err != nil {
		return nil, fmt.Errorf("获取沙箱列表失败: %v", err)
	}
	if len(sandboxes) == 0 {
		return nil, fmt.Errorf("没有可用的沙箱，请先创建一个远程沙箱")
	}
	return sandboxes[0], nil
}

func waitForIdle(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient, sandboxID string) error {
	startTime := time.Now()

	for {
		isIdle, err := client.CheckIdle(ctx, sandboxID)
		if err != nil {
			log.Printf("⚠️  检查空闲状态失败: %v", err)
		}

		if isIdle {
			fmt.Println("✅ Planner 服务空闲，准备执行任务")
			return nil
		}

		if time.Since(startTime) > maxIdleWaitTime {
			return fmt.Errorf("等待 Planner 空闲超时（>%v），当前有其他任务正在执行", maxIdleWaitTime)
		}

		fmt.Println("⏳ Planner 服务繁忙，等待中...")
		time.Sleep(idlePollInterval)
	}
}

func selectModel(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient, sandboxID string) (string, error) {
	models, err := client.ListModels(ctx, sandboxID)
	if err != nil {
		return "", fmt.Errorf("获取模型列表失败: %v", err)
	}
	if len(models) == 0 {
		return "", fmt.Errorf("没有可用的模型")
	}
	return models[0].Name, nil
}

// ─── 任务执行 ─────────────────────────────────────────────

func runTask(ctx context.Context, client *lumi_cua_sdk.LumiCuaClient, taskPrompt, sandboxID, model string) error {
	messageChan, err := client.RunTask(ctx, taskPrompt, sandboxID, model, "", "enabled", taskTimeoutSeconds)
	if err != nil {
		if taskBusyErr, ok := err.(*lumi_cua_sdk.TaskBusyError); ok {
			return fmt.Errorf("任务排队中（沙箱繁忙）: %v", taskBusyErr)
		}
		return fmt.Errorf("启动任务失败: %v", err)
	}

	messageCount := 0
	for message := range messageChan {
		messageCount++
		fmt.Printf("\n── 步骤 %d ──\n", messageCount)
		fmt.Printf("   摘要: %s\n", message.Summary)
		fmt.Printf("   动作: %s\n", message.Action)

		if message.Screenshot != "" && len(message.Screenshot) > 64 {
			fmt.Printf("   截图: [已捕获, %d bytes]\n", len(message.Screenshot))
		}

		switch message.Action {
		case "error":
			return fmt.Errorf("任务执行出错（步骤 %d）: %s", messageCount, message.Summary)
		case "timeout":
			return fmt.Errorf("任务超时（%ds）: %s", taskTimeoutSeconds, message.Summary)
		}
	}

	fmt.Printf("\n✅ 任务执行结束，共 %d 个步骤\n", messageCount)
	return nil
}

// ─── 截图保存 ─────────────────────────────────────────────

func saveScreenshot(ctx context.Context, sandbox *lumi_cua_sdk.Sandbox, projectDir string) {
	screenshotDir := filepath.Join(projectDir, "data", "temp")
	if err := os.MkdirAll(screenshotDir, 0755); err != nil {
		log.Printf("⚠️  创建截图目录失败: %v", err)
		return
	}
	screenshotPath := filepath.Join(screenshotDir, "final_screenshot.png")

	finalScreenshot, err := sandbox.Screenshot(ctx)
	if err != nil {
		log.Printf("⚠️  获取最终截图失败: %v", err)
		return
	}

	if err := saveBase64Image(finalScreenshot.Base64Image, screenshotPath); err != nil {
		log.Printf("⚠️  保存截图失败: %v", err)
		return
	}

	fmt.Printf("📸 最终截图已保存: %s\n", screenshotPath)
}

func saveBase64Image(s, filePath string) error {
	if idx := strings.Index(s, ","); idx != -1 {
		s = s[idx+1:]
	}

	imageData, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return fmt.Errorf("Base64 解码失败: %v", err)
	}

	return os.WriteFile(filePath, imageData, 0644)
}
