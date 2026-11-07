# @kido/crew-scheduler

> **Event Crew Scheduling & Skill Dispatch Engine** for high-end cinematography, event coverage, and interactive photobooth operations at **T-RED Media** ([tred.vn](https://tred.vn)) & **T-RED Photobooth** ([fotobooth.vn](https://fotobooth.vn)).

---

## 🌟 Key Features

1. **Skill & Specialization Matching (`findQualifiedCrew`)**
   - Matches crew based on certified skills: `GLAMBOT_OPERATOR`, `CINEMATOGRAPHER`, `PHOTOGRAPHER`, `LIGHTING_TECH`, `BOOTH_HOST`, `TECH_LEAD`.
   - Filters strictly by operational city (`DA_NANG`, `HO_CHI_MINH`).
   - Prioritizes candidates by Primary Role, Seniority (`LEAD` > `SENIOR` > `JUNIOR`), Rating, and Experience.

2. **Double Shift Guard (`hasShiftConflict`)**
   - Strictly prevents an individual crew member from being scheduled to concurrent overlapping events.
   - Automatically handles status transitions (ignores `CANCELLED` shifts).

3. **Intra-City & Inter-City Travel Buffer Engine**
   - Automatically pads **60 to 90 minutes** of travel buffer between consecutive shows at different venues within the same city (e.g. Da Nang / Saigon).
   - Zero buffer required for back-to-back shifts at the exact same venue.
   - Enforces inter-city relocation buffer (360 minutes / 6 hours) between Da Nang and Ho Chi Minh City.

4. **Optimal Roster Dispatcher (`suggestOptimalRoster`)**
   - Solves the crew allocation problem using a constraint-satisfaction backtracking algorithm.
   - Guarantees no crew member is double-assigned to multiple roles within the same show.
   - Flags missing/unfilled roles and reports candidate shortage.

5. **Freelance Event Payout Calculator (`calculatePayout` & `calculateShowRosterPayout`)**
   - Base hourly rates determined by seniority level:
     - `JUNIOR`: 150,000 VND / hour
     - `SENIOR`: 250,000 VND / hour
     - `LEAD`: 350,000 VND / hour
     - Customizable custom hourly rates.
   - **Night Shift Premium (+30% after 23:00)**: Automatically calculates exact fractional night hours between 23:00 and 06:00 and adds +30% allowance.
   - **KPI Over-Achievement Bonus**: Rewards crew when photobooth print counts or event guest attendee targets are exceeded.

---

## 📦 Installation

```bash
pnpm add @kido/crew-scheduler
```

---

## 🚀 Quick Start

### 1. Skill Matching & Availability

```typescript
import { findQualifiedCrew } from '@kido/crew-scheduler';

const availableGlambotOperators = findQualifiedCrew(
  crewMembers,
  ['GLAMBOT_OPERATOR'],
  'DA_NANG',
  new Date('2026-11-20T17:00:00+07:00'),
  new Date('2026-11-20T21:00:00+07:00'),
  existingAssignments,
  { travelBufferMinutes: 60 }
);
```

### 2. Double Shift & Travel Buffer Guard

```typescript
import { hasShiftConflict } from '@kido/crew-scheduler';

const isConflicted = hasShiftConflict(
  'crew-001',
  '2026-11-20T18:30:00+07:00',
  '2026-11-20T22:30:00+07:00',
  existingAssignments,
  60, // 60 min travel buffer
  furamaVenue
);

if (isConflicted) {
  console.warn('Cannot assign crew: insufficient transit buffer between venues!');
}
```

### 3. Automatic Show Roster Dispatching

```typescript
import { suggestOptimalRoster } from '@kido/crew-scheduler';

const roster = suggestOptimalRoster(
  eventShow,
  allCrewMembers,
  existingAssignments
);

if (roster.isComplete) {
  console.log('Equip fully dispatched:', roster.assignments);
} else {
  console.warn('Shortage of crew for roles:', roster.unfilledRoles);
}
```

### 4. Payout & Night Shift Calculation

```typescript
import { calculatePayout } from '@kido/crew-scheduler';

const payout = calculatePayout({
  member: seniorCrewMember,
  show: overnightShow, // 20:00 to 01:00 (5 hours, 2 night hours)
});

console.log(payout);
// Base amount (5h x 250k) = 1,250,000 VND
// Night bonus (2h x 250k x 30%) = 150,000 VND
// Total = 1,400,000 VND
```

---

## 🧪 Testing & Build

```bash
# Run unit tests
pnpm run test

# Typecheck
pnpm run typecheck

# Build bundle (ESM + CJS + DTS)
pnpm run build
```

---

## 📄 License

MIT © T-RED Media & T-RED Photobooth
