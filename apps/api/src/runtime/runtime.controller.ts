import { Body, Controller, Post } from "@nestjs/common";
import { runtimePairInputSchema } from "@devproof/contracts";

import { parseBody } from "../common/validation.js";
import { BrowserRuntimeService } from "../console/browser-runtime.service.js";

@Controller("runtime")
export class RuntimeController {
  constructor(private readonly runtimes: BrowserRuntimeService) {}

  @Post("pair")
  pair(@Body() body: unknown) {
    return this.runtimes.pair(parseBody(runtimePairInputSchema, body));
  }
}
