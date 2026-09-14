import { it, expect } from "vitest";
import { notificationConfigurationError } from "./notification-error.js";
it("stops retrying bot configuration failures without suppressing transient failures", () => {
  expect(
    notificationConfigurationError(
      "Feishu rejected notification: Bot Not Enabled",
    )?.code,
  ).toBe("FEISHU_BOT_NOT_ENABLED");
  expect(notificationConfigurationError("503 Service Unavailable")).toBeNull();
  expect(notificationConfigurationError("request timeout")).toBeNull();
});
