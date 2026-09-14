/** Provider configuration failures cannot recover by retrying the same payload. */
export function notificationConfigurationError(message: string) {
  if (/Bot Not Enabled/iu.test(message))
    return {
      code: "FEISHU_BOT_NOT_ENABLED",
      message:
        "飞书应用未启用机器人能力。请在飞书开放平台启用机器人、发布版本并确认当前租户安装了该版本；修复配置后再重发通知。",
    };
  if (
    /app (?:is )?(?:disabled|deleted)|invalid app(?:lication)? (?:id|secret)/iu.test(
      message,
    )
  )
    return {
      code: "FEISHU_APP_CONFIGURATION_INVALID",
      message: "飞书应用配置不可用，请检查应用状态和凭据后重发通知。",
    };
  return null;
}
