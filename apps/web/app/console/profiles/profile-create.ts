import type { UserBrowserProfileCreateInput } from "@devproof/contracts";
import type { Profile } from "./profile-types";

export interface ProfileCreateDraft {
  websiteUrl: string;
  displayName: string;
  environmentKey: string;
  authRole: string;
}

export function profileCreateInput(
  draft: ProfileCreateDraft,
): UserBrowserProfileCreateInput {
  let url: URL;
  try {
    url = new URL(draft.websiteUrl.trim());
  } catch {
    throw new Error(
      "请填写完整的网站地址，例如 https://app.example.com/dashboard。",
    );
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("网站地址必须使用 HTTP 或 HTTPS。");
  }
  if (url.username || url.password) {
    throw new Error("网站地址不能包含用户名或密码，请在打开的登录窗口中输入。");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  return {
    displayName: draft.displayName.trim() || hostname.slice(0, 160),
    verificationUrl: url.toString(),
    environmentKey: draft.environmentKey.trim() || "default",
    authRole: draft.authRole.trim() || "default",
    grants: ["CONSOLE"],
  };
}

export function existingProfileForDraft(
  profiles: Profile[],
  draft: ProfileCreateDraft,
) {
  try {
    const input = profileCreateInput(draft);
    const hostname = new URL(input.verificationUrl).hostname
      .toLowerCase()
      .replace(/\.$/u, "");
    return profiles.find(
      (profile) =>
        profile.siteHostname?.toLowerCase().replace(/\.$/u, "") === hostname &&
        profile.environmentKey === input.environmentKey &&
        profile.authRole === input.authRole,
    );
  } catch {
    return undefined;
  }
}
