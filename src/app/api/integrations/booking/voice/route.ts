import { handleMachineBookingRequest } from "@/lib/booking/channel-http";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { return handleMachineBookingRequest(request, "voice"); }
