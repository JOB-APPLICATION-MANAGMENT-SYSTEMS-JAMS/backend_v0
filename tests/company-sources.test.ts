/**
 * Company sources for pitch search: the curated contact-list HTML parser
 * (lca.logcluster.org) and the Stargate firmographics record mapper
 * (backend/openapi.yaml, POST /firmographics/v1/search firstPageRecords shape).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContactList, detectCity, slugName } from "../src/services/logcluster";
import { mapFirmographicsRecord, SECTOR_KEYWORDS } from "../src/search/stargate";

/** Mirrors the real logcluster markup: nested <p>, mailto links, &nbsp; padding. */
const FIXTURE = `
<table>
  <thead>
    <tr>
      <th scope="col">SN</th><th scope="col">Airline Name</th><th scope="col">Address</th>
      <th scope="col">Website</th><th scope="col">Email</th><th scope="col">Phone Contact</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row"><p>1&nbsp;</p></th>
      <td><p>Arik Air&nbsp;</p></td>
      <td><p>Lagos. Murtala Muhammed Domestic Airport,&nbsp;</p></td>
      <td><p><a href="http://www.arikair.com/">www.arikair.com&amp;nbsp</a>&nbsp;</p></td>
      <td><p><a href="mailto:talktous@arikair.com">talktous@arikair.com</a></p></td>
      <td><p>01 279 9999&nbsp;</p></td>
    </tr>
    <tr>
      <th scope="row"><p>2&nbsp;</p></th>
      <td><p>Green Africa Airways&nbsp;</p></td>
      <td><p>Ilorin International Airport, Kwara State&nbsp;</p></td>
      <td><p><a href="https://www.greenafrica.com">www.greenafrica.com&amp;nbsp;</a></p></td>
      <td><p>&nbsp;</p></td>
      <td><p>0700-47336-237422&nbsp;</p></td>
    </tr>
    <tr>
      <th scope="row"><p>3&nbsp;</p></th>
      <td><p>Ghost Air&nbsp;</p></td>
      <td><p>Nowhere&nbsp;</p></td>
      <td><p>&nbsp;</p></td>
      <td><p>&nbsp;</p></td>
      <td><p>&nbsp;</p></td>
    </tr>
    <tr>
      <th scope="row"><p>4&nbsp;</p></th>
      <td><p>Max Air&nbsp;</p></td>
      <td><p>16, Ashton Road, Kano, Kano state Nigeria&nbsp;</p></td>
      <td><p>www.maxair.com.ng&nbsp;</p></td>
      <td><p>cs@maxair.com.ng reservation@maxair.com.ng</p></td>
      <td><p>+234 909 009 2221 +234 909 009 2207&nbsp;</p></td>
    </tr>
    <tr>
      <th scope="row"><p>5&nbsp;</p></th>
      <td><p>Associated Aviation&nbsp;</p></td>
      <td><p>56 MKO Abiola Crescent, Toyan Street, Lagos&nbsp;</p></td>
      <td><p>www.associatedaviationlimited.com&nbsp;</p></td>
      <td><p>info@.associatedaviationlimited.com&nbsp;</p></td>
      <td><p>+234-1 4973700&nbsp;</p></td>
    </tr>
    <tr>
      <th scope="row"><p>6&nbsp;</p></th>
      <td><p>Dana Air&nbsp;</p></td>
      <td><p>116, Oshodi-Apapa Expressway, Isolo, Lagos&nbsp;</p></td>
      <td><p>info@danagroup.com&nbsp;</p></td>
      <td><p>contact@danagroup.com</p></td>
      <td><p>+234 0201 280 9999&nbsp;</p></td>
    </tr>
    <tr>
      <th scope="row"><p>7&nbsp;</p></th>
      <td><p>Allied Air&nbsp;</p></td>
      <td><p>Ground Floor SAHCOL Office Complex Murtala Muhammed Airport, Lagos&nbsp;</p></td>
      <td><p>www.alliedairng.com&nbsp;</p></td>
      <td><p>info@alliedairng.com&nbsp;</p></td>
      <td><p>Tel : 01-271-6732 | 01-271-6733&nbsp;</p></td>
    </tr>
    <tr>
      <th scope="row"><p>8&nbsp;</p></th>
      <td><p>Value Jet&nbsp;</p></td>
      <td><p>31 Ladoke Akintola Street, Ikeja GRA, Lagos&nbsp;</p></td>
      <td><p>www.flyvaluejet.com&nbsp;</p></td>
      <td><p>valueflyer@flyvaluejet.com&nbsp;</p></td>
      <td><p>2.348E+12&nbsp;</p></td>
    </tr>
    <tr>
      <td><p>Arik Air&nbsp;</p></td>
      <td><p>Lagos. Murtala Muhammed Domestic Airport,&nbsp;</p></td>
      <td><p>www.arikair.com&nbsp;</p></td>
      <td><p>talktous@arikair.com</p></td>
      <td><p>01 279 9999&nbsp;</p></td>
    </tr>
  </tbody>
</table>`;

test("parseContactList maps cells by content, skips headers and dead rows", () => {
  const rows = parseContactList(FIXTURE, "airline");
  assert.equal(rows.length, 7, "published, derived and multi-contact rows kept; header and contactless row dropped");

  const arik = rows.find((r) => r.name === "Arik Air")!;
  assert.ok(arik, "name detected");
  assert.equal(arik.email, "talktous@arikair.com");
  assert.equal(arik.email_derived, 0, "published email is not a guess");
  assert.equal(arik.website, "https://www.arikair.com");
  assert.equal(arik.phone, "01 279 9999");
  assert.equal(arik.sector, "airline");
  assert.ok(arik.external_id.startsWith("list:airline:"), "stable list-prefixed id");
  assert.equal(arik.city, "Lagos");

  // no email in the table row, but a website exists → derived info@ and flagged;
  // a double-escaped entity (&amp;nbsp;) must not leak into the website URL
  const green = rows.find((r) => r.name === "Green Africa Airways")!;
  assert.equal(green.email, "info@greenafrica.com");
  assert.equal(green.email_derived, 1);
  assert.equal(green.website, "https://www.greenafrica.com");

  // duplicate name appears once (row 4 is a repeat of row 1)
  assert.equal(rows.filter((r) => r.name === "Arik Air").length, 1);

  // multi-number phone cells keep their full string; first email of a multi-email cell wins
  const max = rows.find((r) => r.name === "Max Air")!;
  assert.equal(max.phone, "+234 909 009 2221 +234 909 009 2207");
  assert.equal(max.email, "cs@maxair.com.ng");
  assert.equal(max.website, "https://www.maxair.com.ng");

  // malformed email (info@.example.com) is never sent: falls back to a derived one
  const assoc = rows.find((r) => r.name === "Associated Aviation")!;
  assert.equal(assoc.email, "info@associatedaviationlimited.com");
  assert.equal(assoc.email_derived, 1);
  assert.equal(assoc.website, "https://www.associatedaviationlimited.com");

  // the website column holds an email: still a lead, no website, email column wins
  const dana = rows.find((r) => r.name === "Dana Air")!;
  assert.equal(dana.email, "contact@danagroup.com");
  assert.equal(dana.website, null);

  // "Tel : 01-271-6732 | 01-271-6733" is a phone; Excel-corrupted "2.348E+12" is not
  const allied = rows.find((r) => r.name === "Allied Air")!;
  assert.equal(allied.phone, "Tel : 01-271-6732 | 01-271-6733");
  const vj = rows.find((r) => r.name === "Value Jet")!;
  assert.equal(vj.phone, null);
  assert.equal(vj.email, "valueflyer@flyvaluejet.com");
});

test("detectCity reads Nigerian cities from the address, defaults to Nigeria", () => {
  assert.equal(detectCity("26 Burma Road, Apapa, Lagos, Nigeria"), "Lagos");
  assert.equal(detectCity("Terminal A, Tincan Island Port, Apapa"), "Apapa");
  assert.equal(detectCity("Somewhere Rural"), "Nigeria");
  assert.equal(slugName("Arik Air!"), "arik-air");
});

test("mapFirmographicsRecord maps the openapi firstPageRecords shape", () => {
  const row = mapFirmographicsRecord(
    {
      uniqueID: "0888783282",
      businessName: "Infobel",
      address1: "Avenue Louise 231",
      city: "Ixelles",
      phone: "02 379 29 40",
      email: "info@kapitol.com",
      website: "http://www.infobel.com",
    },
    "company"
  )!;
  assert.equal(row.name, "Infobel");
  assert.equal(row.email, "info@kapitol.com");
  assert.equal(row.email_derived, 0);
  assert.equal(row.website, "http://www.infobel.com");
  assert.equal(row.city, "Ixelles");
  assert.equal(row.external_id, "stargate:0888783282");

  // no name → nothing usable; website without scheme gets one
  assert.equal(mapFirmographicsRecord({ uniqueID: "x" }, "company"), null);
  const bare = mapFirmographicsRecord({ uniqueID: "y", businessName: "Bare Co", website: "bare.ng" }, "company")!;
  assert.equal(bare.website, "https://bare.ng");
  assert.equal(bare.email, null, "a row without email is still a lead");

  assert.equal(SECTOR_KEYWORDS.airline, "airline");
  assert.equal(SECTOR_KEYWORDS.port, "port terminal");
});
