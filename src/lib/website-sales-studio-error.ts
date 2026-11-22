export class WebsiteStudioError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'WebsiteStudioError'; }
}
