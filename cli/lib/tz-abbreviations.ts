/**
 * Timezone abbreviation → IANA mapping.
 * Where abbreviations are ambiguous, the most commonly expected mapping is used.
 * Users can also specify full IANA names directly (e.g. "Asia/Tokyo").
 */
export const TZ_ABBREVIATIONS: Record<string, string> = {
  // Americas
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  MST: 'America/Denver', MDT: 'America/Denver',
  CST: 'America/Chicago', CDT: 'America/Chicago',
  EST: 'America/New_York', EDT: 'America/New_York',
  AKST: 'America/Anchorage', AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  AST: 'America/Puerto_Rico', ADT: 'America/Halifax',
  NST: 'America/St_Johns', NDT: 'America/St_Johns',
  BRT: 'America/Sao_Paulo', BRST: 'America/Sao_Paulo',
  ART: 'America/Argentina/Buenos_Aires',
  CLT: 'America/Santiago', CLST: 'America/Santiago',
  COT: 'America/Bogota', PET: 'America/Lima',
  VET: 'America/Caracas', ECT: 'America/Guayaquil',
  // Europe
  GMT: 'Europe/London', BST: 'Europe/London',
  UTC: 'UTC',
  WET: 'Europe/Lisbon', WEST: 'Europe/Lisbon',
  CET: 'Europe/Berlin', CEST: 'Europe/Berlin',
  EET: 'Europe/Bucharest', EEST: 'Europe/Bucharest',
  MSK: 'Europe/Moscow',
  IST: 'Asia/Kolkata',
  IRST: 'Asia/Tehran', IRDT: 'Asia/Tehran',
  // Asia
  PKT: 'Asia/Karachi', NPT: 'Asia/Kathmandu',
  BDT: 'Asia/Dhaka', MMT: 'Asia/Yangon',
  THA: 'Asia/Bangkok', ICT: 'Asia/Bangkok',
  WIB: 'Asia/Jakarta', WITA: 'Asia/Makassar', WIT: 'Asia/Jayapura',
  SGT: 'Asia/Singapore', MYT: 'Asia/Kuala_Lumpur',
  PHT: 'Asia/Manila', HKT: 'Asia/Hong_Kong',
  CST_CHINA: 'Asia/Shanghai',
  JST: 'Asia/Tokyo', KST: 'Asia/Seoul', GST: 'Asia/Dubai',
  // Oceania
  AWST: 'Australia/Perth',
  ACST: 'Australia/Adelaide', ACDT: 'Australia/Adelaide',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
  NZST: 'Pacific/Auckland', NZDT: 'Pacific/Auckland',
  // Africa
  WAT: 'Africa/Lagos', CAT: 'Africa/Harare',
  EAT: 'Africa/Nairobi', SAST: 'Africa/Johannesburg',
}
