/**
 * Checks src/lib/billing-calendar.ts against the examples in the reverse
 * billing contract itself.
 *
 *   npx tsx scripts/verify-billing-calendar.ts
 *
 * This repo has no test runner and this script deliberately does not add one.
 * The billing calendar decides when every client owes money, and it is pure, so
 * it is worth pinning down exactly — the contract's March/April 2026 calendars
 * give us known-good answers to check against.
 */
import {
  addDays,
  buildMonthlyCutoffs,
  buildWeeklyPeriods,
  clampToMonth,
  dueDateFor,
  isWithin,
  lastDayOfMonth,
  bookingTermDays,
  nextFridayOnOrAfter,
  periodBoundsFor,
  rolloverTarget,
  weekday,
  type Day,
  type WeeklyPeriod,
} from '../src/lib/billing-calendar.js'

let passed = 0
const failures: string[] = []

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
  } else {
    failures.push(`${label}\n      expected ${e}\n      actual   ${a}`)
  }
}

function throws(label: string, fn: () => unknown): void {
  try {
    fn()
    failures.push(`${label}\n      expected a throw, got none`)
  } catch {
    passed++
  }
}

function section(name: string): void {
  console.log(`\n${name}`)
}

/** A weekly period flattened to just the fields the contract pins down. */
function shape(w: WeeklyPeriod) {
  return {
    period: `${w.periodStart}..${w.periodEnd}`,
    days: w.operatingDays,
    merged: w.merged,
    sent: w.summarySendDay,
    review: `${w.reviewWindow.start}..${w.reviewWindow.end}`,
  }
}

// ---------------------------------------------------------------------------
section('Day arithmetic')

check('Mar 1 2026 is a Sunday', weekday('2026-03-01'), 0)
check('Mar 31 2026 is a Tuesday', weekday('2026-03-31'), 2)
check('addDays across a month end', addDays('2026-03-31', 1), '2026-04-01')
check('addDays backwards', addDays('2026-04-01', -1), '2026-03-31')
check('addDays across a year end', addDays('2026-12-31', 1), '2027-01-01')
check('February 2026 has 28 days', lastDayOfMonth(2026, 2), 28)
check('February 2024 has 29 days', lastDayOfMonth(2024, 2), 29)
check('clamp overflows to month end', clampToMonth(2026, 2, 30), '2026-02-28')
check('clamp leaves valid days alone', clampToMonth(2026, 3, 30), '2026-03-30')
throws('rejects a non-date', () => weekday('2026-02-31'))
throws('rejects a malformed day', () => weekday('03/02/2026'))

// ---------------------------------------------------------------------------
section('Friday-only payment rule')

// Week of Mon 2 March 2026 through Sun 8 March 2026.
check('Monday  -> that Friday',      nextFridayOnOrAfter('2026-03-02'), '2026-03-06')
check('Tuesday -> that Friday',      nextFridayOnOrAfter('2026-03-03'), '2026-03-06')
check('Wednesday -> that Friday',    nextFridayOnOrAfter('2026-03-04'), '2026-03-06')
check('Thursday -> that Friday',     nextFridayOnOrAfter('2026-03-05'), '2026-03-06')
check('Friday   -> itself',          nextFridayOnOrAfter('2026-03-06'), '2026-03-06')
check('Saturday -> following Friday', nextFridayOnOrAfter('2026-03-07'), '2026-03-13')
check('Sunday   -> following Friday', nextFridayOnOrAfter('2026-03-08'), '2026-03-13')

// A Service Invoice issued on the last day of March, per the worked example.
check('30-day term from Mar 30', dueDateFor('2026-03-30', 30), '2026-05-01')
check('45-day term from Mar 30', dueDateFor('2026-03-30', 45), '2026-05-15')
check('60-day term from Mar 30', dueDateFor('2026-03-30', 60), '2026-05-29')
throws('rejects an unsupported term', () => dueDateFor('2026-03-30', 15))

// ---------------------------------------------------------------------------
section('Weekly billing — March 2026')

// From the contract's March calendar: weeks ringed Mon-Sat, the send day
// circled, and the client's three review days underlined.
check('March 2026 yields four billing weeks', buildWeeklyPeriods(2026, 3).length, 4)
check('March 2026 weeks', buildWeeklyPeriods(2026, 3).map(shape), [
  { period: '2026-03-02..2026-03-07', days: 6, merged: false, sent: '2026-03-09', review: '2026-03-10..2026-03-12' },
  { period: '2026-03-09..2026-03-14', days: 6, merged: false, sent: '2026-03-16', review: '2026-03-17..2026-03-19' },
  { period: '2026-03-16..2026-03-21', days: 6, merged: false, sent: '2026-03-23', review: '2026-03-24..2026-03-26' },
  // Mar 30-31 is a 2-day tail, so it folds back into the week before it.
  { period: '2026-03-23..2026-03-31', days: 8, merged: true,  sent: '2026-04-01', review: '2026-04-02..2026-04-04' },
])

section('Weekly billing — April 2026')

// April opens mid-week. The merge rule covers only the LAST week of a month, so
// Apr 1-4 stands on its own even though it is a 4-day stub; the tail Apr 27-30
// does merge. This is the assumption flagged in the plan.
check('April 2026 weeks', buildWeeklyPeriods(2026, 4).map(shape), [
  { period: '2026-04-01..2026-04-04', days: 4, merged: false, sent: '2026-04-06', review: '2026-04-07..2026-04-09' },
  { period: '2026-04-06..2026-04-11', days: 6, merged: false, sent: '2026-04-13', review: '2026-04-14..2026-04-16' },
  { period: '2026-04-13..2026-04-18', days: 6, merged: false, sent: '2026-04-20', review: '2026-04-21..2026-04-23' },
  { period: '2026-04-20..2026-04-30', days: 10, merged: true, sent: '2026-05-01', review: '2026-05-02..2026-05-05' },
])

section('Weekly billing — invariants across two years')

for (let y = 2026; y <= 2027; y++) {
  for (let m = 1; m <= 12; m++) {
    const weeks = buildWeeklyPeriods(y, m)
    const label = `${y}-${String(m).padStart(2, '0')}`

    // No week may be a token 1-4 day stub at the end of a month.
    const tail = weeks[weeks.length - 1]
    if (tail.operatingDays <= 4 && weeks.length > 1) {
      failures.push(`${label}: month ends with an unmerged ${tail.operatingDays}-day week`)
    } else {
      passed++
    }

    // Weeks must tile the month's operating days with no gap and no overlap.
    const covered = weeks.reduce((n, w) => n + w.operatingDays, 0)
    let expected = 0
    for (let d = 1; d <= lastDayOfMonth(y, m); d++) {
      if (weekday(clampToMonth(y, m, d)) !== 0) expected++
    }
    check(`${label}: every operating day is billed exactly once`, covered, expected)

    // No week may cross a month boundary.
    for (const w of weeks) {
      if (w.periodStart.slice(0, 7) !== label || w.periodEnd.slice(0, 7) !== label) {
        failures.push(`${label}: week ${w.periodStart}..${w.periodEnd} escapes the month`)
      } else {
        passed++
      }
    }
  }
}

section('Weekly billing — holidays move the send day, not the week')

// Mon 9 March 2026 is the send day for the Mar 2-7 week. Make it a holiday.
const withHoliday = buildWeeklyPeriods(2026, 3, (d: Day) => d === '2026-03-09')
check('week boundaries are unchanged by a holiday',
  `${withHoliday[0].periodStart}..${withHoliday[0].periodEnd}`, '2026-03-02..2026-03-07')
check('send day slides past the holiday', withHoliday[0].summarySendDay, '2026-03-10')
check('review window slides with it',
  `${withHoliday[0].reviewWindow.start}..${withHoliday[0].reviewWindow.end}`, '2026-03-11..2026-03-13')

// ---------------------------------------------------------------------------
section('Monthly cut-offs — March 2026')

const [mar1, mar2] = buildMonthlyCutoffs(2026, 3)

check('cut-off 1 period', `${mar1.periodStart}..${mar1.periodEnd}`, '2026-03-01..2026-03-15')
check('cut-off 1 consolidation (16th-18th)',
  `${mar1.consolidationWindow.start}..${mar1.consolidationWindow.end}`, '2026-03-16..2026-03-18')
check('cut-off 1 submission (25th-27th)',
  `${mar1.submissionWindow.start}..${mar1.submissionWindow.end}`, '2026-03-25..2026-03-27')
check('cut-off 1 validation (28th-30th)',
  `${mar1.validationWindow.start}..${mar1.validationWindow.end}`, '2026-03-28..2026-03-30')

check('cut-off 2 period', `${mar2.periodStart}..${mar2.periodEnd}`, '2026-03-16..2026-03-31')
check('cut-off 2 consolidation (1st-3rd next month)',
  `${mar2.consolidationWindow.start}..${mar2.consolidationWindow.end}`, '2026-04-01..2026-04-03')
check('cut-off 2 submission (10th-12th)',
  `${mar2.submissionWindow.start}..${mar2.submissionWindow.end}`, '2026-04-10..2026-04-12')
check('cut-off 2 validation (13th-15th)',
  `${mar2.validationWindow.start}..${mar2.validationWindow.end}`, '2026-04-13..2026-04-15')

// The contract's own Cut-off 1 calendar underlines 28-30 March, and 29 March is
// a Sunday — so these windows are calendar ranges, not operating days.
check('validation windows are calendar days, Sundays included',
  isWithin('2026-03-29', mar1.validationWindow), true)

section('Monthly cut-offs — short months')

const [feb26] = buildMonthlyCutoffs(2026, 2)
check('Feb 2026 cut-off 1 validation clamps to the 28th',
  `${feb26.validationWindow.start}..${feb26.validationWindow.end}`, '2026-02-28..2026-02-28')
const [feb24] = buildMonthlyCutoffs(2024, 2)
check('Feb 2024 cut-off 1 validation clamps to the 29th',
  `${feb24.validationWindow.start}..${feb24.validationWindow.end}`, '2024-02-28..2024-02-29')
const [, feb26b] = buildMonthlyCutoffs(2026, 2)
check('Feb 2026 cut-off 2 runs to the 28th',
  `${feb26b.periodStart}..${feb26b.periodEnd}`, '2026-02-16..2026-02-28')

section('Monthly cut-offs — year boundary')

const [, dec2] = buildMonthlyCutoffs(2026, 12)
check('December cut-off 2 is worked in January',
  `${dec2.submissionWindow.start}..${dec2.submissionWindow.end}`, '2027-01-10..2027-01-12')

section('Late submission rolls to the next cycle')

const rolled1 = rolloverTarget(mar1)
check('missed cut-off 1 rolls into cut-off 2', [rolled1.cutoffNo, rolled1.submissionWindow.start], [2, '2026-04-10'])
const rolled2 = rolloverTarget(mar2)
check('missed cut-off 2 rolls into next month cut-off 1', [rolled2.cutoffNo, rolled2.submissionWindow.start], [1, '2026-04-25'])
const rolledDec = rolloverTarget(dec2)
check('rollover crosses the year', [rolledDec.cutoffNo, rolledDec.submissionWindow.start], [1, '2027-01-25'])

// ---------------------------------------------------------------------------
section('Assigning a booking to its period')

check('monthly: the 15th is cut-off 1',
  (periodBoundsFor('2026-03-15', 'monthly') as typeof mar1).cutoffNo, 1)
check('monthly: the 16th is cut-off 2',
  (periodBoundsFor('2026-03-16', 'monthly') as typeof mar1).cutoffNo, 2)
check('weekly: a Saturday job belongs to its own week',
  shape(periodBoundsFor('2026-03-07', 'weekly') as WeeklyPeriod).period, '2026-03-02..2026-03-07')
check('weekly: a month-end job lands in the merged week',
  shape(periodBoundsFor('2026-03-31', 'weekly') as WeeklyPeriod).period, '2026-03-23..2026-03-31')
throws('weekly: a Sunday has no billing week', () => periodBoundsFor('2026-03-08', 'weekly'))

// ---------------------------------------------------------------------------
section('Payment term comes straight off the booking')

// One Service Invoice covers one booking, so there is no multi-booking term to
// reconcile — only the stored value to normalise. bookings.payment_terms is a
// varchar, so it arrives in whatever shape the form sent.
check('numeric string', bookingTermDays('45'), 45)
check('number',         bookingTermDays(60), 60)
check('with a suffix',  bookingTermDays('30 days'), 30)
check('unrecognised falls back to the shortest term', bookingTermDays('90'), 30)
check('null falls back to the shortest term',         bookingTermDays(null), 30)
check('empty falls back to the shortest term',        bookingTermDays(''), 30)

// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(60)}`)
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed\n`)
  for (const f of failures) console.log(`  x ${f}\n`)
  process.exit(1)
}
console.log(`PASSED — all ${passed} checks green`)
