import { handleWebsiteSalesMachine } from "@/lib/website-sales-machine";

export const POST = (request: Request) => handleWebsiteSalesMachine(request);
