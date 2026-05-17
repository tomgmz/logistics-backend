declare module 'idanalyzer2' {
  export class Scanner {
    constructor(apiKey: string)
    throwApiException(enabled: boolean): void
    setProfile(profile: Profile): void
    quickScan(document: string, backDocument?: string, saveTransaction?: boolean): Promise<Record<string, any>>
    scan(document: string, backDocument?: string, biometricPhoto?: string): Promise<Record<string, any>>
  }

  export class Profile {
    static readonly SECURITY_NONE: string
    static readonly SECURITY_LOW: string
    static readonly SECURITY_MEDIUM: string
    static readonly SECURITY_HIGH: string
    constructor(securityLevel?: string)
  }

  export class APIError extends Error {
    code: number
    msg: string
  }

  export class InvalidArgumentException extends Error {}

  export function SetEndpoint(url: string): void

  const IdAnalyzer: {
    Scanner: typeof Scanner
    Profile: typeof Profile
    APIError: typeof APIError
    InvalidArgumentException: typeof InvalidArgumentException
    SetEndpoint: typeof SetEndpoint
  }

  export default IdAnalyzer
}