/**
 * Exclusive track-sale contracts.
 *
 * Ported from a separate Python app that filled a `{PLACEHOLDER}` template and shelled out
 * to pandoc and wkhtmltopdf. Neither binary can be assumed on a machine running a packed
 * Electron app, and Electron renders PDFs itself - so the templating is a few lines of
 * string work here and the PDF comes from `webContents.printToPDF`.
 */

/** Who the producer is, and the terms that don't change between deals. */
export interface ContractProfile {
  fullName: string
  alias: string
  email: string
  /** Governing law, as it should read in the contract - the old app shouted it. */
  governingState: string
  /** What gets delivered, e.g. "ZIP FILE OF WAV FILES (STEMS) and MASTER WAV FILE". */
  fileType: string
}

/** A buyer worth remembering. Keyed by alias, falling back to name. */
export interface ContractPreset {
  name: string
  alias: string
  email: string
}

/** Everything a contract needs that isn't in the profile. */
export interface ContractInput {
  /** One entry per track. Several become a single agreement over combined Masters. */
  titles: string[]
  customer: string
  alias: string
  email: string
  /** USD, digits only. */
  price: string
  /** The producer's retained shares, as percentages of two separate 100% pools. */
  producerWriter: string
  producerPublisher: string
}

/** A contract that was generated, kept so it can be reopened or done again. */
export interface ContractRecord {
  id: string
  /** ISO, to the second. */
  when: string
  input: ContractInput
  markdownPath: string
  pdfPath: string | null
  /** Why the PDF is missing, when it is. */
  pdfError?: string
}

export interface ContractData {
  profile: ContractProfile
  presets: ContractPreset[]
  history: ContractRecord[]
  /** The template itself, editable - it is the actual legal text. */
  template: string
  /** Where contracts are written. Empty means the default under the library. */
  outputDir: string
}

export const DEFAULT_CONTRACT_PROFILE: ContractProfile = {
  // Blank on purpose. These name a real person in a real legal document, so there is no
  // sensible default - Contracts asks for them once and `umakbang-contracts.json` keeps
  // them from then on.
  fullName: '',
  alias: '',
  email: '',
  governingState: 'CALIFORNIA',
  fileType: 'ZIP FILE OF WAV FILES (STEMS) and MASTER WAV FILE'
}

/**
 * The producer's own terms, carried over from the app this replaces with the terms that
 * belonged to one particular deal taken back out - a named publishing administrator and a
 * fixed $400 advance were in the original because it was written for a single sale. The
 * template is editable in the app, so a term that only applies to some deals belongs in the
 * copy the user edits rather than in the default everybody starts from.
 */
export const DEFAULT_CONTRACT_TEMPLATE = `This Exclusive **{PRODUCT_TITLE}** Track Sale Agreement (the "Agreement"),
having been made on and effective as of **{CONTRACT_DATE}** (the
"Effective Date") by and between **{PRODUCT_OWNER_FULLNAME}** p/k/a **{PRODUCER_ALIAS}** ("Producer");
and **{CUSTOMER_FULLNAME}** p/k/a **{CUSTOMER_ALIAS}** ("Purchaser").

The following sets forth the material terms and conditions of the agreement by and between
**{PRODUCER_ALIAS}** and **{CUSTOMER_FULLNAME}** with respect to the audio recording(s) set forth on
Schedule 1 (the "Master(s)"). In the event the number of audio recordings hereunder is one (1), then all
references to "Master(s)" shall be deemed to refer to such single Master.

For good and valuable consideration (the receipt and sufficiency of which are hereby acknowledged),
the parties hereby agree as follows:

This Agreement is issued solely in connection with and for Purchaser's use of the Track pursuant and
subject to all terms and conditions set forth herein.

---

### 1. <u>**Rights**</u>

Producer hereby assigns and transfers to Purchaser one hundred percent (100%) of all rights, title, and
interest in and to the Master(s) (excluding the underlying musical composition(s) embodied therein
[the “Composition”]).

Purchaser shall have full ownership and control of the Master(s) in perpetuity and throughout the
universe, including, without limitation, the right to distribute, monetize, perform, sublicense, and
otherwise exploit the Master(s) in any form or media.

Producer retains **no ownership** in the Master(s) but retains a **{PROD_WRITER}% writer's share** and a
**{PROD_PUBLISHER}% publisher's share** of the Composition(s), as detailed in Section 5.

---

### 2. <u>**Delivery of the Track**</u>

1. Producer agrees to deliver the Track as a high-quality **{FILE_TYPE}**, as such term is understood in the
   music industry.

2. Producer shall use commercially reasonable efforts to deliver the Track to Purchaser immediately
   after payment of the Fee is made. Purchaser will receive the Track via email, to the email address
   Purchaser provided to Producer.

---

### 3. <u>**Fee / Royalty**</u>

Purchaser shall pay to Producer a non-returnable, non-recoupable fee in the amount of
**{PRODUCT_PRICE_WORD}** Dollars (**{PRODUCT_PRICE}**) (the "Fee").
The Fee shall be payable upon full execution of this Agreement and prior to delivery of the Track.

Producer shall retain only their agreed **writer's and publisher's shares** of the Composition(s), and
shall have no right to receive any share of streaming or master royalties in connection with the
Master(s).

---

### 4. <u>**Mechanical License**</u>

Purchaser acknowledges and agrees that Producer is a co-author and co-owner of the underlying
Composition embodied in the Master(s). Producer hereby grants Purchaser a license to reproduce,
distribute, and publicly perform the Composition solely in connection with Purchaser’s exploitation of
the Master(s).

Producer shall be entitled to receive **twenty-five percent (25%)** of all mechanical royalties generated
from the use and exploitation of the Composition, corresponding to Producer’s ownership share.

For licenses outside the United States and Canada, the mechanical royalty rate shall be the prevailing
industry-wide rate in the applicable territory. Purchaser agrees to provide Producer with accurate
accounting statements reflecting such mechanical royalty income no less than semi-annually.

---

### 5. <u>**Publishing Rights**</u>

With respect to the publishing rights and ownership of the Composition(s), the parties agree as follows:

- Producer shall own **{PROD_WRITER}%** of the writer's share and **{PROD_PUBLISHER}%** of the publisher's
  share of the Composition(s). The writer's share and the publisher's share are each treated as a separate
  one hundred percent (100%) pool.

- Purchaser (and/or Purchaser's designated publishing administrator) shall own the remaining
  **{PURCH_WRITER}%** of the writer's share and **{PURCH_PUBLISHER}%** of the publisher's share.

Each party shall be entitled to administer, collect, and exploit their respective shares independently,
including registration with their chosen PRO or publishing administrator.

Producer’s publishing share shall entitle Producer to receive its **respective share of all publishing income**, including performance, mechanical, and synchronization royalties corresponding to Producer’s ownership.

Purchaser agrees to credit Producer as a co-writer and to provide Producer with all necessary metadata,
including ISRC, ISWC, and any other identifiers required for proper royalty registration.

---

### 6. <u>**Credit and Likeness**</u>

Purchaser shall have the right to use Producer's approved name, likeness, and biographical material
for purposes of trade and otherwise without restriction solely in connection with the Master(s).

Purchaser shall ensure that Producer is credited substantially as follows:  
**"Produced by {PRODUCER_ALIAS}"**

Producer shall have the right to use Purchaser’s approved name and likeness solely in connection with
the Master(s) and Composition(s) created under this Agreement.

---

**Payment Confirmation:**  
Purchaser’s full payment of the Fee shall constitute acceptance and execution of this Agreement,
whether or not a physical or digital signature is provided.

**Ownership Confirmation:**  
Upon receipt of full payment, Purchaser shall be the sole and exclusive owner of one hundred percent
(100%) of the Master(s). Producer retains no ownership in the Master(s) but maintains its
**writer's and publisher's shares** of the Composition(s) as provided herein.

**Electronic Signature Consent:**  
Electronic signatures, including PDF, scanned signatures, or signatures via online platforms, shall be
deemed valid and binding.

**Recordkeeping and Timestamp Verification:**  
Timestamp, IP address, and metadata associated with execution shall serve as proof of agreement.

**Independent Contractor:**  
Producer is an independent contractor and not an employee, partner, or agent of Purchaser.

**Severability and Survival:**  
If any provision is deemed invalid, the remainder shall continue in full force. Rights that naturally
survive termination shall remain in effect.

**Governing Law and Jurisdiction:**  
This Agreement shall be governed by the laws of **{STATE_PROVINCE_COUNTRY}**. Each party submits to the
exclusive jurisdiction of courts located in **{STATE_PROVINCE_COUNTRY}**.

---

### **IN WITNESS WHEREOF**

The parties hereto have executed this Agreement as of the Effective Date.

**{PRODUCT_OWNER_FULLNAME}** p/k/a **{PRODUCER_ALIAS}**  
Signature: _____________________________  

**{CUSTOMER_FULLNAME}** p/k/a **{CUSTOMER_ALIAS}**  
Signature: _____________________________  

---

**Schedule 1:**  
**Master(s):** **{PRODUCT_TITLE}**  
**File Type:** **{FILE_TYPE}**  
**Contract Date:** **{CONTRACT_DATE}**  
**Fee:** **{PRODUCT_PRICE}**  
**Producer Publishing Share:** **{PROD_WRITER}% Writer / {PROD_PUBLISHER}% Publisher**  
**Purchaser Publishing Share:** **{PURCH_WRITER}% Writer / {PURCH_PUBLISHER}% Publisher**  
**Streaming/Master Royalty Participation:** **Producer Waives All Rights**  
**Governing State/Province/Country:** **{STATE_PROVINCE_COUNTRY}**
`

/** Every token the template can carry, for the preferences screen to list. */
export const CONTRACT_PLACEHOLDERS = [
  'PRODUCT_TITLE',
  'CONTRACT_DATE',
  'PRODUCT_OWNER_FULLNAME',
  'PRODUCER_ALIAS',
  'CUSTOMER_FULLNAME',
  'CUSTOMER_ALIAS',
  'PRODUCT_PRICE',
  'PRODUCT_PRICE_WORD',
  'PROD_WRITER',
  'PROD_PUBLISHER',
  'PURCH_WRITER',
  'PURCH_PUBLISHER',
  'FILE_TYPE',
  'STATE_PROVINCE_COUNTRY'
] as const
