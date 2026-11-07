// Legacy entry point now shares the saved, versioned mailing contract.
// Raw recipient/HTML requests cannot bypass draft approval or durable dispatch.
import { GET as readSavedMailings, POST as writeSavedMailings } from "@/app/api/crm/newsletter/route";

export const maxDuration = 300;
export const GET = readSavedMailings;
export const POST = writeSavedMailings;
