import { handleVoiceBookingRequest } from "@/lib/booking/studio-voice-authority";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) { return handleVoiceBookingRequest(request); }
