// Run the same actual product cases against standalone 096 -> 100, not the Preview schema.
process.env.STUDIO_ENQUIRY_TEST_SCHEMA = "production";
await import("./studio-enquiry-tests.ts");
