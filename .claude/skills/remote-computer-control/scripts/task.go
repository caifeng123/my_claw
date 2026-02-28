package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"code.byted.org/iaasng/lumi-cua-go-sdk/src/lumi_cua_sdk"
)

func main() {
	// 从命令行参数获取 taskPrompt
	if len(os.Args) < 2 {
		log.Fatalf("Usage: %s <taskPrompt>", os.Args[0])
	}
	taskPrompt := os.Args[1]

	// Initialize Client
	client := lumi_cua_sdk.NewLumiCuaClient(
		"https://iaas-cua-devbox-ecs-manager-v2.byted.org/mgr",
		"https://iaas-cua-devbox-planner-agent.byted.org/planner",
		"aa65501b-e033-49c5-9ff4-b03eeaf3baeb",
	)

	ctx := context.Background()

	sandboxes, err := client.ListSandboxes(ctx)
	if err != nil {
		log.Fatalf("Failed to list sandboxes: %v", err)
	}

	var sandbox *lumi_cua_sdk.Sandbox
	if len(sandboxes) == 0 {
		fmt.Println("No existing sandboxes found. Just Return")
		log.Fatalf("No existing sandboxes found.")
		return
	} else {
		sandbox = sandboxes[0]
		fmt.Printf("Using existing sandbox: ID=%s, IP=%s\n", sandbox.ID(), sandbox.IPAddress())
	}

	// 等待服务空闲
	for {
		isIdle, err := client.CheckIdle(ctx, sandbox.ID())
		if err != nil {
			log.Printf("Failed to check idle status: %v", err)
		}

		if isIdle {
			fmt.Println("Planner service is idle, ready to run tasks")
			break
		}

		fmt.Println("Planner service is busy, waiting...")
		time.Sleep(5 * time.Second)
	}

	// Step 2: Get Available Models
	models, err := client.ListModels(ctx, sandbox.ID())
	if err != nil {
		log.Fatalf("Failed to list models: %v", err)
	}

	if len(models) == 0 {
		log.Fatalf("No models available")
	}

	timeoutSeconds := 300

	messageChan, err := client.RunTask(ctx, taskPrompt, sandbox.ID(), models[0].Name, "", "enabled", timeoutSeconds)
	if err != nil {
		// Handle specific error types
		if taskBusyErr, ok := err.(*lumi_cua_sdk.TaskBusyError); ok {
			log.Printf("Task is busy: %v", taskBusyErr)
			fmt.Println("Another task is currently running. Please wait and try again later.")
		} else {
			log.Printf("Failed to run task: %v", err)
		}
	} else {
		fmt.Println("Starting task execution...")
		messageCount := 0
		for message := range messageChan {
			messageCount++
			fmt.Printf("=== Message %d ===\n", messageCount)
			fmt.Printf("Summary: %s\n", message.Summary)
			fmt.Printf("Action: %s\n", message.Action)
			fmt.Printf("TaskID: %s\n", message.TaskID)

			// Handle error message (SDK统一检测到的异常情况)
			if message.Action == "error" {
				fmt.Printf("❌ Task error: %s\n", message.Summary)
				break
			}

			// Handle timeout message
			if message.Action == "timeout" {
				fmt.Printf("⚠️  Task timed out after %d seconds\n", timeoutSeconds)
				break
			}

			if message.Screenshot != "" {
				fmt.Printf("Screenshot (first 64 chars): %s...\n", message.Screenshot[:64])
			}
		}

		fmt.Printf("Task execution ended. Total messages received: %d\n", messageCount)
	}

	// 截图
	finalScreenshot, err := sandbox.Screenshot(ctx)
	if err != nil {
		log.Printf("Failed to take final screenshot: %v", err)
	} else {
		err = saveBase64Image(finalScreenshot.Base64Image, "final_screenshot.png")
		if err != nil {
			log.Printf("Failed to save final screenshot: %v", err)
		} else {
			fmt.Println("✅ Final screenshot saved as final_screenshot.png")
		}
	}
}

// save base64 image
func saveBase64Image(s, filePath string) error {
	if idx := strings.Index(s, ","); idx != -1 {
		s = s[idx+1:]
	}
	// 解码base64字符串
	imageData, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return fmt.Errorf("failed to decode base64 string: %v", err)
	}

	// 创建文件
	file, err := os.Create(filePath)
	if err != nil {
		return fmt.Errorf("failed to create file: %v", err)
	}
	defer file.Close()

	// 写入文件
	_, err = file.Write(imageData)
	if err != nil {
		return fmt.Errorf("failed to write to file: %v", err)
	}

	return nil
}
