// CRM-01 / IAM-24: HBC-YYYY-NNNNNN-C, C = Luhn mod-10 check digit over the year + sequence digits.
export function luhnDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function customerNo(year: number, n: number): string {
  const seq = String(n).padStart(6, "0");
  return `HBC-${year}-${seq}-${luhnDigit(`${year}${seq}`)}`;
}

export function isCustomerNo(s: string): boolean {
  const m = /^HBC-(\d{4})-(\d{6})-(\d)$/.exec(s);
  return !!m && luhnDigit(m[1] + m[2]) === Number(m[3]);
}
