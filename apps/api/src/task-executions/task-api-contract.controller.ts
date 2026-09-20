import { Controller, Get } from "@nestjs/common";
import { taskApiContract } from "./task-api-contract.js";

@Controller("v2/openapi.json")
export class TaskApiContractController {
  @Get()
  get() {
    return taskApiContract();
  }
}
