# Demo script (about 8 minutes)

Follows the README's demo transcript. Open https://travis-roofing-crm.travis-oracle-web.workers.dev and
wait for the top-right chip to read "Data: snapshot …" before recording.

1. **Open the CRM on Travis County (30 s).** Point out the county chip, the dashed county extent on the map
   and the default pin at downtown Austin. Click the data chip to show the snapshot, manifest CID and the
   tables read from IPFS, then close it.
   > "The CRM consumes the published Travis County snapshot; ingestion is a separate pipeline."
2. **Drop a pin and set a radius (45 s).** Click a spot in north-central Austin (e.g. Allandale) to drop
   the pin, and set the radius to 1 mile. Optionally show **Use my location** (it only accepts points
   inside the county).
3. **Roofs older than the threshold (45 s).** Turn off the permit criterion and leave **Roof older than 15
   years** on. Show the count, the roof-age column with confidence, and the orange markers. Change 15 to 25
   and show the count drop.
4. **Open permits, long-open first (1 min).** Click **Long-open permits only** (open at least 5 years).
   Sort by **Open permit**. Show the red markers, "Expired, never finaled" statuses and years open.
5. **Property and permit detail (1 min).** Click the top row. Walk through the roof evidence, owner,
   and the permit card: status, opened and expires dates, **open for N years**, contractor and phone,
   registry match, and BBB. Click **Check BBB ↗** (BBB's own search opens in a new tab), read the rating,
   come back and click **record**: choose the rating, accreditation and paste the profile link, then save.
   The rating now shows with a "rep-entered" tag here, in the candidate list and on any lead for that
   contractor.
   > "BBB has no public API and blocks automation, so the app never scrapes it; reps check BBB in one click
   > and record what they see, and the rating follows the contractor everywhere."
6. **Convert matches into leads (45 s).** Click **Save as lead** in the panel, close it, tick three more
   rows and click **Save 3 as leads**. Show the toast, the check marks and the Leads badge.
7. **Manage leads (1 min).** Open **Leads**: stage tabs with counts. Open a lead, move it to
   **Contacted**, set an assignee and next-action date, **Save changes**, add a note. Show the activity
   timeline and the disabled Email/SMS, Estimate and Route buttons.
8. **RAG assistant (1.5 min).** Open **Assistant** and click "Show me open roofing permits older than five
   years within five miles of Rollingwood". Expand the search line to show the SQL, show the result table,
   and read the answer (total matches, permit numbers, years open, contractors). Tick two rows and **Save as
   leads**. Ask a second question, e.g. "Which homes near Allandale were hit by large hail in the last 3
   years?"
9. **Filter by roof age, permit status/duration and radius (45 s).** Back in the finder: turn roof age and
   open permit on, choose **Match all**, untick **Open (active)** so only expired-never-finaled permits
   count, and change the radius. Turn on **Severe hail since roof** to show the third signal.
10. **Future sections (30 s).** Click **Insurance claims** and **Outreach campaigns** under "Coming soon"
    to show the disabled previews.
