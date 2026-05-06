export enum OntologyErrorCode {
  DUPLICATE_RESOURCE = 'DUPLICATE_RESOURCE',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  INVALID_LINK_TYPE = 'INVALID_LINK_TYPE',
  INVALID_CRON_EXPRESSION = 'INVALID_CRON_EXPRESSION',
  TYPE_MISMATCH = 'TYPE_MISMATCH',
}

export class OntologyError extends Error {
  constructor(
    public readonly code: OntologyErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'OntologyError'
  }
}
