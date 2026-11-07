import { handleEvelynRuntimeRequest } from "@/lib/shared-behavior/runtime-http";
export const POST = (request: Request) => handleEvelynRuntimeRequest(request, "signal");
