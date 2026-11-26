/**
 * What the client help assistant's AI answers may say: the ONLY source Gemini
 * is given. Nothing outside these passages may be stated as fact.
 *
 * Two parts:
 *   1. ASSISTANT_KNOWLEDGE is a COPY of the help assistant's FAQ in the web
 *      app (logistics-frontend/src/lib/support/faq.ts), same ids, answers and
 *      'public' audience. When an answer there changes,
 *      change it here too: the ids are how a cited answer gets its "Open …"
 *      button on the web.
 *   2. BUSINESS_KNOWLEDGE: the company (landing page: lib/data.ts) and how 8338
 *      runs deliveries, written for CLIENTS from the System User Guide
 *      (docs/user-guide, checked against the code 2026-11-12/14) and the
 *      CLAUDE.md register. Staff-only procedures (permissions, logs, IT, how the
 *      office works its screens) are left out on purpose: a client may learn
 *      what happens and why, not how to operate staff tools.
 *
 * Keep both in step with the system: an outdated passage becomes a confident
 * outdated answer.
 */

export interface KnowledgePassage {
  id:       string
  question: string
  answer:   string
  /**
   * Who may be answered from it. Unset = everyone. 'client' = signed-in
   * clients only (their account, tickets, contract); 'public' = visitors on
   * the landing page only (becoming a client).
   */
  audience?: 'client' | 'public'
}

export const ASSISTANT_KNOWLEDGE: KnowledgePassage[] = [
  {
    id: 'become-client',
    question: 'How do I become a client?',
    answer:
      'Accounts are set up by our team, so there is no sign-up form. Send us a message through the contact form ' +
      'on this page with your company name and what you need delivered, and we will reply by email. Once your ' +
      'account is ready you sign in with the email address you gave us.',
    audience: 'public',
  },
  {
    id: 'what-we-deliver',
    question: 'What do you deliver?',
    answer:
      'We move goods business to business, mainly fast-moving consumer goods (FMCG): from your warehouse or ' +
      'supplier to stores and distribution points, with a company truck and driver, live tracking and photo ' +
      'proof at every drop-off.',
    audience: 'public',
  },
  {
    id: 'book',
    question: 'How do I book a delivery?',
    answer:
      'Go to Booking and follow the steps: the pickup point, up to 3 drop-off points, your cargo, then the ' +
      'date and call time. You don\'t choose the truck: our Operations Manager assigns the vehicle and driver ' +
      'after your booking is approved.',
  },
  {
    id: 'lead-time',
    question: 'How far ahead do I need to book?',
    answer:
      'Same-day bookings are accepted until 12:00 noon, Monday to Saturday, with a call time later than ' +
      'the time you book. After 12:00 noon on any day, and all day on Sundays, the earliest date you can pick is ' +
      'tomorrow. You can ' +
      'book up to one month in advance (the same date next month). Call times are set in 5-minute steps.',
  },
  {
    id: 'hours',
    question: 'What are your office hours? Do you deliver on Sundays?',
    answer:
      'Our office reviews bookings Monday to Saturday, 8:00 AM to 5:00 PM. A booking sent outside those hours ' +
      'is still received and is reviewed on the next working day. Deliveries themselves run 7 days a week, ' +
      'Sundays included.',
  },
  {
    id: 'dropoffs',
    question: 'How many drop-off points can one booking have?',
    answer:
      'Up to 3 drop-off points per booking. If you need more, split them across two bookings. Our team plans the ' +
      'route order; the driver may change the order on the road (for example if a site is closed), and you ' +
      'will see where the truck is heading on Transit Tracking.',
  },
  {
    id: 'approval',
    question: 'How do I know if my booking was approved or rejected?',
    answer:
      'You get a notification (the bell at the top) as soon as the General Manager or the Company ' +
      'Administrator approves or rejects it. A rejection always includes the reason. You can see the status ' +
      'of every booking in Transaction History.',
  },
  {
    id: 'rejected',
    question: 'My booking was rejected. What now?',
    answer:
      'The notification and the booking in Transaction History show the reason it was turned down. Open it and ' +
      'choose Edit & Resubmit: fix what the reason mentions (often the date, cargo details or an address) and ' +
      'resubmit; it goes back for approval with the same booking number. A booking can be resubmitted at most 3 ' +
      'times; after that you can only cancel it and make a new booking. Or choose Cancel Booking. If the reason ' +
      'is unclear, tap "Talk to our team" in the help assistant and we will explain.',
  },
  {
    id: 'change-cancel',
    question: 'Can I change or cancel a booking?',
    answer:
      'Once a booking is approved, changes and cancellations go through our team so the vehicle and driver can ' +
      'be updated too. In the help assistant tap "Talk to our team" and send the booking reference and what you ' +
      'need changed; we reply in the same conversation (and by email if you are away).',
  },
  {
    id: 'track',
    question: 'How do I track my delivery?',
    answer:
      'Every delivery can be followed live. Once the truck is on the road, clients see it move on the map under ' +
      'Transit Tracking, with the estimated arrival at each drop-off, which drop-offs are done, and which one ' +
      'the driver is heading to. A photo is taken at every drop-off as proof.',
  },
  {
    id: 'no-truck-on-map',
    question: 'Why can\'t I see the truck on the map?',
    answer:
      'The truck appears only while the delivery is in transit, from the moment the driver confirms loading at ' +
      'your pickup point. Before that the map shows the planned route. If it is in transit and still not ' +
      'showing, the driver may be in an area with no signal; the position updates again once they reconnect.',
  },
  {
    id: 'arrival-window',
    question: 'When will my delivery arrive?',
    answer:
      'There is no planned arrival time given in advance. The truck must be at your pickup point by your call ' +
      'time (the pick-up time you booked). Once the driver starts the delivery, Transit Tracking shows a live ' +
      'estimate for each drop-off based on traffic, which updates as the truck moves.',
  },
  {
    id: 'multi-trip',
    question: 'My cargo needs more than one truckload. How does that work?',
    answer:
      'The same truck makes several trips: it loads at your pickup point, unloads at the drop-off, and comes ' +
      'back for the next load. Each load has its own loading and delivery photo. On Transit Tracking a ' +
      'drop-off shows "2/3 loads" and is only marked done when the last load arrives.',
  },
  {
    id: 'confirm-completion',
    question: 'The driver finished. Do I need to do anything?',
    answer:
      'Yes, please confirm it. When the last drop-off is done you get a notification and an email asking you to ' +
      'confirm the booking is complete, or to report a problem. If you do neither, it completes automatically ' +
      '3 days after delivery.',
  },
  {
    id: 'report-problem',
    question: 'Something was wrong with my delivery. How do I report it?',
    answer:
      'Open the booking in Transaction History and choose "Report a problem" before you confirm it. That stops ' +
      'the automatic completion and alerts our Operations team. Once they mark it resolved you get a fresh 3 ' +
      'days to confirm, or to report again.',
  },
  {
    id: 'proof',
    question: 'Where can I see the proof of delivery?',
    answer:
      'Open the booking in Transaction History. It shows the photo taken at each drop-off (with time, place and ' +
      'plate stamped on it), the proof of pickup photos, and the delivery documents our team has approved.',
  },
  {
    id: 'notifications',
    question: 'How will you contact me about my bookings?',
    answer:
      'Through the bell at the top of the portal (approval, rejection, delivery finished and more) and by email ' +
      'for the important steps, like a finished delivery that needs your confirmation. When you talk to our team ' +
      'in the help assistant, their replies show in Messages, and by email if you are away. Support tickets are ' +
      'answered by email.',
  },
  {
    id: 'password',
    question: 'I forgot my password or can\'t sign in.',
    answer:
      'On the sign-in page choose "Forgot password". Your request goes to our IT Administrator, who sends ' +
      'you a reset link by email. The link works once and expires 5 minutes after it is sent, so open it ' +
      'soon. Asking again does not create a second request: it reminds the administrator, and replaces a link that ' +
      'expired. If you get back in another way (signing in or changing your password), the request closes on its ' +
      'own. Any email address works for an account (Gmail, Yahoo, Outlook or a company domain), as long as you ' +
      'can receive mail there. After 3 wrong passwords or codes in a row, the account locks for 3 minutes; wait, ' +
      'then try again. After 9 wrong tries in a row (three of those locks) it stays locked until you reset your ' +
      'password with "Forgot password"; we email you when that happens, and the IT Administrator is told. ' +
      'Already signed in and want a new password? Open Profile (your name at the bottom of the sidebar) and ' +
      'choose Request Change Password: it goes to the IT Administrator the same way, and after you set the new ' +
      'password you sign in again on every device. Profile also has your User Guide, a step-by-step PDF written ' +
      'for your role (the Client guide for clients) that opens in a new tab.',
  },
  {
    id: 'account-details',
    question: 'How do I change my company details or contact person?',
    answer:
      'Company details are kept by our team so your bookings stay consistent. In the help assistant tap "Talk to ' +
      'our team" and tell us what needs to change (company name, address, contact person, phone); we update it ' +
      'and confirm in the conversation.',
 
    audience: 'client',
  },
  {
    id: 'pricing',
    question: 'How much does a delivery cost? How do I pay?',
    answer:
      'This system handles bookings and deliveries only: no prices, amounts or payments are shown or taken ' +
      'here. Rates and payment are arranged with our team directly. Send us your question through the contact ' +
      'form, or through "Talk to our team" in the help assistant if you are already a client.',
  },
  {
    id: 'second-driver',
    question: 'Why are there two drivers on my booking?',
    answer:
      'Routes longer than 30 km by road always get a second driver for safety. Shorter routes have one driver, ' +
      'sometimes with a helper. Both drivers can confirm the pickup, the drop-offs and the proof photos, so a ' +
      'confirmation may show either driver’s name.',
  },
]

const P = (id: string, question: string, answer: string, audience?: 'client' | 'public'): KnowledgePassage =>
  ({ id, question, answer, ...(audience ? { audience } : {}) })

/** The company and how it operates, for clients. See the header for sources. */
export const BUSINESS_KNOWLEDGE: KnowledgePassage[] = [
  // ── The company ────────────────────────────────────────────────────────────
  P('biz-about', 'What is 8338 Logistics?',
    '8338 Logistics Services is a delivery company in the Philippines that moves goods business to business, ' +
    'mainly fast-moving consumer goods (FMCG): from a client\'s warehouse or supplier to stores and distribution ' +
    'points. Clients book, track and confirm deliveries in the 8338 web portal; drivers run them with the 8338 ' +
    'driver app.'),
  P('biz-services', 'What services does 8338 offer?',
    'Our services: cargo movement with company trucks and drivers, delivery scheduling planned by our ' +
    'Operations team, real-time delivery visibility (live tracking with arrival estimates), and complete delivery ' +
    'records (stamped photo proof at every stop, documents and times kept per booking).'),
  P('biz-contact', 'How do I contact 8338 Logistics?',
    'Phone: +63 9685 536 8975. Email: 8338LogisticsServices@gmail.com. Office: Blk. 6 Lot 8 Lynville Enclave, ' +
    'Mamatid, City of Cabuyao, Laguna. Clients can also tap "Talk to our team" in the help assistant and get our ' +
    'reply in the same conversation (and by email if they are away).'),
  P('biz-area', 'Where do you deliver?',
    'Pickups and drop-offs must be in the Philippines; the booking map only accepts places in the Philippines.'),
  P('biz-fmcg-only', 'What kind of booking can I make?',
    'The service type is FMCG (fast-moving consumer goods), from one pickup point to one to three drop-off points ' +
    'per booking. The signed delivery receipt and the photo proof are the record of each delivery.'),
  P('biz-no-payments', 'Does the portal handle quotes, invoices or payments?',
    'No. The portal handles bookings and deliveries only; no prices, amounts or payments are shown or taken in it. ' +
    'Rates and payment are arranged with our team directly.'),
  P('biz-one-session', 'Why was I signed out? Can I stay signed in on two devices?',
    'An account can be signed in on only one browser or device at a time. Signing in somewhere else signs you out ' +
    'everywhere else, and the portal tells you so. If you did not sign in elsewhere yourself, sign in again and ' +
    'change your password, and contact us if it happens again. Each person at your company should use their own account.'),

  // ── Booking details ───────────────────────────────────────────────────────
  P('ops-booking-cargo', 'What cargo details does a booking need?',
    'For each drop-off you enter the goods as Palletized (the default) or Loose. Palletized: number of pallets, ' +
    'pallet type (Standard 120x100 cm, Euro 120x80 cm, Half 60x80 cm, or Custom), and gross and net weight per ' +
    'pallet. Loose: number of pieces, size and weight. Sizes can be typed in centimetres, metres or inches, and ' +
    'weights in kilograms or pounds; they are converted to centimetres and kilograms for the calculations, and ' +
    'sizes are shown back in the unit you typed them in. Net weight must be ' +
    'less than gross weight. You also ' +
    'pick the commodity, product and special handling code, and mark the goods as stackable or not, non-tiltable, ' +
    'or oversize. Volume and density are worked out for you.'),
  P('ops-booking-files', 'What files do I need to attach to a booking?',
    'Every booking needs 1 to 3 transaction documents attached, up to 10 MB each.'),
  P('ops-oversize', 'What does Oversize mean on a booking?',
    'Oversize marks goods that may need a larger vehicle. Our team checks the load when assigning a vehicle.'),
  P('ops-call-time', 'What is the call time?',
    'The call time is the time on the booking day when the truck should be at your pickup point. You pick it in ' +
    '5-minute steps when booking. After the vehicle and driver are assigned, our Operations team sets the ' +
    'driver\'s own call time: when the driver leaves so the truck reaches you on time. It is always earlier than ' +
    'your call time (it can be the night before an early-morning pick-up).'),
  P('ops-after-hours', 'What happens if I book after office hours?',
    'You can send a booking at any time. One sent outside office hours (Monday to Saturday, 8:00 AM to 5:00 PM) ' +
    'is reviewed when the office opens.'),
  P('ops-approval-who', 'Who approves my booking?',
    'Every booking is checked by a person: our General Manager (or the Company Administrator) reviews the pickup, ' +
    'drop-offs, cargo, documents and schedule, then approves or rejects it. Bookings are never approved ' +
    'automatically. A rejection always says why.'),

  // ── Vehicles and drivers ──────────────────────────────────────────────────
  P('ops-vehicle-choice', 'How is the truck chosen for my booking?',
    'After approval our Operations Manager chooses the vehicle and driver based on your cargo: weight, volume, ' +
    'size and whether it can be stacked. You do not choose the truck. Most deliveries use our company fleet; ' +
    'sometimes a vendor-supplied vehicle and driver from a partner is used.'),
  P('ops-vehicle-safety', 'How do you make sure the truck is safe?',
    'A vehicle can only be assigned after it passes a BLOWBAGETS safety inspection, and it is inspected again ' +
    'after every delivery before its next job. A vehicle with an overdue service, an expired registration, or one ' +
    'under maintenance cannot be assigned. Before each delivery our team re-checks the vehicle the day before and ' +
    'on the day.'),
  P('ops-driver-checks', 'Are your drivers licensed and checked?',
    'Yes. Every driver\'s license is scanned and checked against the LTO\'s records when the driver is added ' +
    'and when it is renewed. A driver whose license is expired on the delivery day cannot be assigned.'),
  P('ops-number-coding', 'Do you follow number coding?',
    'Yes. When our team picks a vehicle, vehicles under MMDA number coding on the delivery day are flagged, so the ' +
    'schedule can take it into account.'),
  P('ops-helper', 'What is a helper on my booking?',
    'Routes of 30 km or less have one driver and sometimes a helper who assists with loading and unloading. ' +
    'Longer routes always get a second driver.'),
  P('ops-two-drivers-app', 'With two drivers, who confirms my delivery and whose phone shows the truck?',
    'Both drivers have the same steps in the driver app, so either one can confirm the pickup, a drop-off and the ' +
    'proof photo; the record shows who did it. Only one phone navigates at a time, and that phone is the truck you see ' +
    'on the tracking map. If the drivers switch phones on the road, the map keeps following the same truck. A ' +
    'confirmation only counts when the phone is at the stop and with the truck; otherwise our team checks it first. ' +
    'Every change of driver, second driver, helper or vehicle on your booking is recorded by our team.'),

  // ── On the road ───────────────────────────────────────────────────────────
  P('ops-start', 'How do I know my delivery has started?',
    'You get a notification ("Your delivery is on its way") when the driver starts. From then on you can follow ' +
    'the truck live on Transit Tracking.'),
  P('ops-stop-steps', 'What happens at each stop?',
    'At the pickup and at every drop-off the driver records four steps in order: arrived (only within 300 m of ' +
    'the stop), started loading or unloading, finished, then a proof photo. The photo is stamped with the plate, ' +
    'time, place and driver, and must be taken near the stop. These stop times are shown on your booking.'),
  P('ops-driver-reorder', 'Can the driver change the order of my drop-offs?',
    'Yes, the driver may change the order on the road, for example when a bay is closed or because of traffic. ' +
    'Our office is told why. If the new order makes one of your drop-offs about 30 minutes or more later than ' +
    'its earlier estimate, you get a notification with the new estimated time.'),
  P('ops-delay', 'What happens if my delivery is running late?',
    'Delayed means the truck has not reached your pickup point by your call time (the pick-up time you booked). ' +
    'Our system checks every few minutes; once your call time passes without the truck there, the booking is ' +
    'marked Delayed and you are notified, with the time it is now expected there when the truck is reporting its ' +
    'position, then again for every further 30 minutes. The Delayed mark clears when the truck reaches your ' +
    'pickup point. After pick-up there is no Delayed mark: Transit Tracking shows a live estimate for each ' +
    'drop-off. If the driver has not started on time, our office is alerted earlier and follows it up with the ' +
    'driver. A paused delivery is not marked Delayed; the pause notice explains why.'),
  P('ops-pause', 'Why was my delivery paused?',
    'Our office can pause a delivery on the road, for example for weather, a vehicle breakdown, a closed pickup or ' +
    'drop-off, or a closed road. You are notified with the reason. If it continues on another day you get the new ' +
    'date; until a new date is set, the arrival shows "To be confirmed". You are notified again when the delivery ' +
    'is moving again.'),
  P('ops-breakdown', 'What if the truck breaks down?',
    'The driver reports it from the app and our office decides whether to pause the delivery, continue, or send a ' +
    'replacement vehicle or driver (a replacement is arranged while the delivery is paused). A vehicle that broke ' +
    'down is taken out of service until it passes inspection again. You are told when your delivery is paused and ' +
    'when it moves again.'),
  P('ops-replacement', 'Can the driver or truck change during my delivery?',
    'Yes, if needed (for example after a breakdown) our office can replace the driver or the vehicle while the ' +
    'delivery is paused. If the goods move to another truck, the hand-over is recorded with a photo before any ' +
    'drop-off.'),
  P('ops-no-signal', 'What if the driver has no signal?',
    'The driver app keeps working without signal: navigation continues and every step and photo is saved on the ' +
    'phone and sent, with the time it was done, once the signal returns. On your map the truck\'s position may ' +
    'pause until then.'),
  P('ops-emergency', 'What happens in an emergency on the road?',
    'Drivers have an SOS button in the app that alerts our office with the truck\'s position and calls our ' +
    'Operations team at once.'),
  P('ops-sunday-transit', 'Do trucks run on weekends and Sundays?',
    'Yes. Deliveries run 7 days a week, Sundays included. Only the office review of bookings follows office hours.'),

  // ── After delivery ────────────────────────────────────────────────────────
  P('ops-failed', 'What does Failed mean on my booking?',
    'Failed means none of the drop-offs could be delivered (for example the goods were refused, or there was an ' +
    'accident or theft). It is a final status. Our team automatically opens a support ticket for you about it, ' +
    'and you are notified.'),
  P('ops-partly-failed', 'What does Partly Failed mean?',
    'Partly Failed is shown under Delivered or Completed when at least one drop-off was delivered but another ' +
    'could not be.'),
  P('ops-problem-reported', 'What does Problem Reported mean?',
    'It shows under Delivered after you report a problem with the delivery. It stays until our team marks the ' +
    'problem resolved and tells you what was done; you then have 3 days to confirm the booking or report again.'),
  P('ops-statuses', 'What do the booking statuses mean?',
    'Pending: waiting for approval. Approved: approved, waiting for a vehicle and driver. Assigned: vehicle and ' +
    'driver chosen. In Transit: on the road. Delivered: every drop-off done, waiting for your confirmation. ' +
    'Completed: confirmed by you, or automatically 3 days after delivery. Rejected: the booking was not ' +
    'accepted, or was stopped and will not go ahead. Failed: nothing could be delivered. Extra notes such as ' +
    'Resubmitted, Delayed, Paused, Partly Failed or Problem Reported show in small text under the status; ' +
    'when there are several, the first is written out and the rest show as "+1", "+2" and so on, which you ' +
    'can tap or click to see all of them.'),
  P('ops-records', 'How long are my booking records kept?',
    'Every booking stays in Transaction History with its proof photos, documents, decisions and stop times, ' +
    'including after it is completed.'),

  // ── Account ───────────────────────────────────────────────────────────────
  P('ops-contract', 'What happens when my contract expires?',
    'Your contract end date is shown on your Profile (Contract validity) and in a banner in the portal, and you ' +
    'get reminders in the month before it ends. For 7 days after it ends you can still sign in to view your ' +
    'bookings, confirm deliveries and report problems, but not make new bookings. After those 7 days sign-in ' +
    'closes until the contract is renewed. Bookings made before the end still go ahead.', 'client'),
  P('ops-tickets', 'How do support tickets work?',
    'A ticket is for something that needs a formal record, like a complaint, a claim or damaged goods; for a ' +
    'quick question, ask in the help assistant and tap "Talk to our team" instead. To submit a ticket, open the ' +
    'help assistant, go to the Tickets tab at the bottom and tap "Submit a ticket": choose a topic, the booking if ' +
    'it is about one, a subject and what happened. You can have up to 5 open tickets. Our team can also open a ' +
    'ticket for you, or turn your conversation into one (the conversation then closes with the ticket number and ' +
    'everything you wrote goes with it), and we open one ourselves when a delivery fails. You get an email about ' +
    'each ticket; reply to ' +
    'that email to add details. Our team answers by email and you can follow your tickets in the Tickets tab. If a ' +
    'ticket was marked resolved but the problem is not fixed, reply to its email from the address on your account: ' +
    'the ticket opens again and our team is told.', 'client'),
  P('ops-messages', 'Can I message the driver or the office?',
    'Yes, the office. Ask your question in the help assistant; if it cannot help, or you want a person, tap ' +
    '"Talk to our team". The same conversation goes to our Operations Managers and Company Administrators: anyone ' +
    'on the team can answer, you see who did, and you reply right there. If you are away when we reply, we email ' +
    'it to you after about 15 minutes, and replying to that email adds your answer to the same conversation. Your ' +
    'conversations are listed under Messages. We reply Monday to Saturday, 8 AM to 5 PM; a message sent after ' +
    'hours gets an automatic note and is answered when we are back. For a problem with a delivery on the road ' +
    'right now, call us. If you do not answer our reply, we send a reminder after 3 days and the conversation ' +
    'closes after 7 days; our team can also mark it resolved. A conversation only with the assistant closes after ' +
    '24 hours without a new question. Writing in a closed conversation within 7 days opens it again; after that ' +
    'start a new one. Messages are ' +
    'for questions; changes to a booking are made in Booking. Clients cannot message drivers. Older one-to-one ' +
    'messages from a staff member are under Earlier messages and are read-only.', 'client'),
]
