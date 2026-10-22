import { bookingEmbedScript } from "@/lib/booking/embed-runtime";

export async function GET() {
  return new Response(bookingEmbedScript, { headers: {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  } });
}
