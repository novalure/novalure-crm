import { handleAutonomousCrmAccess } from "@/lib/crm-autonomous-access";

export const POST = (request: Request) => handleAutonomousCrmAccess(request);
