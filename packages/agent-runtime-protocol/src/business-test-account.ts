import { z } from "zod";
export const businessTestAccountSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[\p{L}\p{N}][\p{L}\p{N}._@+:-]*$/u,
    "请填写账号标识；操作说明请使用处置意见，不要填入账号。",
  )
  .refine(
    (value) => !/(?:删除|重新创建|允许你|先把|再创建|帮我|重试)/u.test(value),
    "请填写手机号、UUID、邮箱或用户 ID，不要填写操作说明。",
  );
