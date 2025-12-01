// Validation utilities

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

export function isValidPassword(password: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (password.length < 6) {
    errors.push('Password must be at least 6 characters')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export function isValidBoatId(boatId: string): boolean {
  // Boat ID should be alphanumeric, uppercase, 6-20 characters
  const boatIdRegex = /^[A-Z0-9]{6,20}$/
  return boatIdRegex.test(boatId.toUpperCase())
}

export function isValidCoordinate(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

export function sanitizeInput(input: string): string {
  return input.trim().replace(/[<>]/g, '')
}
