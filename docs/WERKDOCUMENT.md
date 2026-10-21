# Werkdocument: JEV-router voor Claude Code

Status: stap 1 tot en met 4 gebouwd (zie Volgorde), de rest is plan. Laatst bijgewerkt: 2026-10-20.

Dit document is de lijst van wat we gaan doen, in welke volgorde, en wat we nog
moeten uitzoeken. Wat hier "gemeten" of "bevestigd" heet, is dat ook; de rest staat
als **open** gemarkeerd.

## Uitgangspunten

1. **Zo automatisch mogelijk.** Modellen, limieten, prijzen en wat een abonnement dekt
   worden opgehaald, niet met de hand in code gezet.
2. **Eén catalogus op GitHub.** Alle gegevens die vaak veranderen staan in één bestand,
   `catalog.json`, in deze repo. Een wijziging daar werkt voor iedereen door, zonder
   nieuwe pluginversie.
3. **Nooit stuk door het netwerk.** Is de catalogus onbereikbaar, dan gebruikt de plugin
   de laatste cache, en anders de tabel die in de code zit. Een onbekend model krijgt
   geen kostenregel (`null`), geen verzonnen bedrag.
4. **Niet in het kritieke pad.** Ophalen gebeurt bij sessiestart en op de achtergrond,
   nooit in `turn.step` (daar geldt een timeout van 1,5 s).

## 1. Catalogus op GitHub (`catalog.json`)

Eén JSON-bestand dat `prices.json` en het plan-overzicht samenvoegt.

Voorstel voor de inhoud:

```jsonc
{
  "schema": 1,
  "updated": "2026-10-20",
  "models": {
    "claude-haiku-5-5": {
      "line": "haiku",
      "maxInputTokens": 1000000,
      // prijs per miljoen tokens; "tiers" voor een hoger tarief boven een drempel
      "price": { "input": "<invullen>", "write5m": "<invullen>", "write1h": "<invullen>", "read": "<invullen>", "output": "<invullen>" },
      // boven deze drempel in prompttokens vervangt dit hele tarief het basistarief
      "priceTiers": [{ "abovePromptTokens": 100000, "input": "<invullen>", "write5m": "<invullen>", "write1h": "<invullen>", "read": "<invullen>", "output": "<invullen>" }]
    }
  },
  "plans": {
    "pro": { "excludeLines": ["fable"] },
    "max": { "excludeLines": [] },
    "api": { "excludeLines": [] }
  },
  // model-id's waaronder een beslismodel te bereiken is; nooit een host of sleutel
  "deciders": {
    "jev": { "latest": "jev-1.14.0" },
    "pplx": { "latest": "pplx-decider-v1.2", "flash": "pplx-decider-flash-v1.2" }
  }
}
```

(Alleen de vorm. De prijzen van Haiku 5.5, inclusief het hogere tarief boven 100K, staan
hier bewust niet: die halen we uit Anthropics prijzenpagina voordat we ze invullen.)

**Ophalen:**
- Van `https://raw.githubusercontent.com/Daltonganger/jev-claude-router/main/catalog.json`.
- Kopie in `$.store`, met een TTL (standaard 6 uur, `JEV_ROUTER_CATALOG_TTL_HOURS`).
  Een `ETag` kan niet: de fetch van de engine geeft geen headers terug.
- Na een mislukte poging 10 minuten geen nieuwe, zodat offline starten één timeout kost.
- `JEV_ROUTER_CATALOG_URL` om te overschrijven (eigen fork). Alleen https, en alleen van
  `raw.githubusercontent.com` tenzij `JEV_ROUTER_ALLOW_CUSTOM_CATALOG=1`.
- `JEV_ROUTER_CATALOG=0` zet het ophalen uit.

**Veiligheid.** De catalogus komt van buiten de code en mag daarom alleen *gegevens*
zetten, nooit gedrag dat een sleutel kan weglekken:
- Schema-validatie bij het inlezen. Een bestand dat niet klopt wordt genegeerd, de
  laatste goede cache blijft staan.
- Getallen worden begrensd (prijzen ≥ 0 en onder een plafond, windows binnen bereik).
- De catalogus mag **geen** endpoints, hosts of API-sleutels bevatten of wijzigen. De
  host-allowlist in `provider.ts` blijft in de code.
- Een afwijking die de prijs van een model meer dan een vaste factor (4×) verandert, wordt
  toegepast én gemeld in de statusregel, niet stil toegepast. (Voorkomt dat een typefout in
  `catalog.json` iedereen op de verkeerde tier zet.)
- Wijzigingen aan `catalog.json` gaan via een pull request of een beschermde branch.

## 2. Automatische sync van modellen

**Bron: `GET /v1/models` van Anthropic** (bevestigd uit de documentatie). Levert per
model: `id`, `display_name`, `line` (`haiku`, `sonnet`, `opus`, `fable`, `mythos`),
`lifecycle`, `max_input_tokens`, `max_tokens` en per effort-niveau of het ondersteund
wordt. Géén prijzen en géén veld voor abonnementen.

Wat daar automatisch uit komt:
- `MODEL_OF`: de nieuwste actieve model-id per `line`.
- `WINDOW_TOKENS`: `max_input_tokens` van dat model (lost het Haiku-200K-probleem op).
- Effort-ondersteuning per model.
- Modellen met `lifecycle` `deprecated` of `retired` worden overgeslagen.

Wat er **niet** automatisch uit komt, en dus uit `catalog.json` moet:
- Prijzen en prijstrappen (bijvoorbeeld het hogere tarief boven 100K prompttokens).
- Welk abonnement welk model dekt.

Volgorde bij het bepalen van een waarde: `catalog.json` (als geldig) → API-gegevens →
ingebouwde tabel. Bij een conflict wint de catalogus, zodat jij een fout in de API of een
nieuwe regel direct kunt corrigeren.

**Open:** een nieuw model wordt pas gerouteerd als er een tier-criterium voor is.
"Nieuwste per `line`" is een beleidskeuze; we leggen vast of een nieuw model direct actief
wordt of eerst in `catalog.json` wordt vrijgegeven.

## 3. Abonnement: Pro, Max, API

- `JEV_ROUTER_PLAN=pro|max|api` als zekere basis.
- Het plan bepaalt via `catalog.json` welke `line`s uitgesloten worden (Pro: Fable uit,
  Max: niet). Dat is hetzelfde mechanisme als `JEV_ROUTER_EXCLUDE`, maar dan automatisch.
- Auto-detectie: **open.** Een API-key zegt niets over Pro of Max. We moeten op de echte
  client testen of de pluginhooks het plan of de gebruikte inlog doorgeven
  (`.claude/types/claude-code.d.ts` bekijken). Lukt dat niet, dan blijft de variabele de
  bron en meldt de plugin bij sessiestart welk plan hij aanneemt.
- **Fable op Pro, volgens Anthropic** (support.claude.com, artikel 15424964, gelezen
  2026-10-21): Fable zit niet in Pro's gebruikslimieten en draait vanaf het eerste token op
  pay-as-you-go-tegoed ("usage credits"). Bij Max is Fable onderdeel van het plan, binnen
  een aandeel van de wekelijkse limiet; daarboven tegoed. Voor Claude Code geldt hetzelfde
  als voor claude.ai; Fable 5.1 vraagt Claude Code 2.1.255 of nieuwer. Dat verandert de
  betekenis van "Fable uit op Pro": Fable is er wel, maar kost echt geld. De standaard blijft
  hem uit te zetten (kostenbescherming), `/jev tiers on fable` zet hem terug, en de
  dollarbedragen in de routeregel zijn voor Fable op Pro dus echte kosten. `catalog.json` kan
  de regel en de toelichting (`note`) per plan corrigeren.
- Op Pro en Max betaal je niet per token maar tegen een gebruikslimiet. De dollarbedragen
  in de routeregel en `JEV_ROUTER_UPGRADE_MAX` zijn dan een maat voor verbruik, niet voor
  kosten. De weergave krijgt een modus die dat niet als geld toont.

## 4. Haiku 5.5 (en elk nieuw model)

Eerst door de catalogus en de sync afgehandeld, maar de code heeft ook een eenmalige
aanpassing nodig:
- `claude-haiku-5` toevoegen aan de prijsmatch (`pricing.ts`); nu valt een 5.x-id door naar
  `null`.
- `Price` krijgt prijstrappen: een tarief boven een drempel in prompttokens per request.
  `usageCost`, de downgrade-afweging (`holdCost`) en de upgrade-limiet gebruiken die.
- Windows en tests aanpassen die van 200K uitgaan (`pricing.test.ts`, `policy.test.ts`,
  `register.test.ts`) en de README-tekst over "too long for haiku".
- Controleren: cache-leesverhouding, minimale cacheprefix en effort-niveaus van Haiku 5.5.
  Uit de documentatie (2026-10-21): Haiku 5.5 kent alle vijf de niveaus (standaard `medium`),
  de minimale cacheprefix is 512 tokens, en cache-lezen kost 10% van invoer (afwijkend:
  Opus 5.5 en Sonnet 5.5 5%, Fable 5.1 2,5%).

### Kost een effort-wijziging op Haiku 5.5 de cache?

Wat de documentatie zegt (platform.claude.com, "Prompt caching" en "Effort"): een wijziging van
de **top-level** `output_config.effort` tussen requests maakt de berichtenblokken van de cache
altijd ongeldig, op elk model. Een wijziging via een **per-bericht**-effort (een
`role: "system"`-bericht met `output_config`, beta-header
`mid-conversation-output-config-2026-07-01`) laat de cache intact; dat bestaat voor Fable 5.1,
Opus 5.5, Opus 5, Sonnet 5.5 en Haiku 5.5, niet voor Sonnet 5 en ouder, en niet op Bedrock
voor Haiku 5.5 of Sonnet 5.5. Dat verklaart de eerdere meting: Sonnet 5 had geen per-bericht-
effort (elke wijziging herschreef de cache), en Haiku 4.5 kent effort niet (de wijziging doet
niets). De vraag voor Haiku 5.5 is dus **welke van de twee Claude Code stuurt**.

Gemeten in Claude Code zelf, op een abonnement (geen API-key nodig), 2026-10-21, Claude Code
2.1.306, `claude -p --effort …` in één sessie (`scripts/measure-effort-cache-cli.sh`):

| Model | Wijziging | Gelezen | Geschreven |
| --- | --- | --- | --- |
| Haiku 5.5 | laag → hoog | 17.135 | 274 |
| Haiku 5.5 | hoog → laag | 17.443 | 221 |
| Haiku 5.5 | laag → medium | 17.664 | 34 |
| Sonnet 5.5 | laag → hoog | 14.920 | 1.497 |
| Sonnet 5.5 | hoog → laag | 16.358 | 135 |

Een effort-wijziging herstart de cache dus **niet**, op Haiku 5.5 en Sonnet 5.5: de prompt van
ongeveer 17k tokens wordt gelezen, niet opnieuw geschreven. Dat past bij de documentatie
(per-bericht-effort). Voorbehouden: het gaat om `-p`-aanroepen met de vlag `--effort`, niet om de
herschrijving die de plugin in `turn.step` doet; per model één reeks; en de aanroep direct na
de eerste `--resume` (en bij Sonnet 5.5 ook een tweede, met gelijke effort) las 0 en schreef de
hele prompt, ongeacht de effort. Dat is een ander effect dan de effort en nog niet verklaard.
Gevolg voor de plugin: `holdsSonnetEffort` houdt een effort-wijziging op Sonnet vast om de
cache te sparen; dat is gemeten op Sonnet 5 en lijkt voor Sonnet 5.5 niet nodig. Dat aanpassen
doen we pas na een meting via de plugin zelf (stap 2 hieronder).

**Via de echte plugin** (2026-10-21, Claude Code 2.1.306, standaard stickiness aan, plugin geladen met
`--plugin-dir` en een stand-in voor Jev, `scripts/probe-plugin-effort.sh`): de plugin stuurt de
effort die de routeregel noemt, en de cache blijft staan.

| Model | Effort die de plugin stuurde | Gelezen | Geschreven |
| --- | --- | --- | --- |
| Haiku 5.5 | medium → xhigh | 17.670 | 291 |
| Haiku 5.5 | xhigh → low | 18.444 | 245 |
| Haiku 5.5 | low → max | 18.689 | 150 |
| Sonnet 5.5 | medium → xhigh | 16.562 | 155 |
| Sonnet 5.5 | xhigh → low | 17.152 | 273 |
| Sonnet 5.5 | low → max | 17.425 | 128 |

Ook hier las de aanroep direct na de eerste `--resume` soms 0 en schreef hij de hele prompt, bij gelijke
effort; geen effort-effect. Conclusie: voor Haiku 5.5 en Sonnet 5.5 kost een effort-wijziging via de
plugin de cache niet. `holdsSonnetEffort` (gemeten op Sonnet 5) hield zo'n wijziging vast zonder dat er
een cache te sparen viel. **Gedaan:** de hold geldt nu alleen voor modellen zonder per-bericht-effort
(`effortKeepsCache` in `pricing.ts`: Sonnet 5 en ouder, en Sonnet 5.5 / Haiku 5.5 op Bedrock). Via de
plugin gecontroleerd: een effort-wijziging waar Jev maar 30% zeker van is, gaat op Sonnet 5.5 door.

Bij deze meting bleek ook dat de plugin in Claude Code 2.1.306 niet laadde: `claude plugin validate`
weigerde `register.ts`, omdat de lader van catalogus en modellijst `$.store` als waarde doorgaf (de
engine staat alleen `$.store.get(…)`-aanroepen toe). Dat is hersteld, en een test bewaakt het. De
unit-tests hadden dit niet gezien; `claude plugin validate .` hoort bij elke oplevering.

Wat nog rest:
1. `ANTHROPIC_API_KEY=… npm run measure-effort-cache` (`scripts/measure-effort-cache.mjs`, een
   paar cent) meet op de API zelf de top-level en de per-bericht-variant naast elkaar. Alleen
   nodig om te weten wat de API doet; voor Claude Code is bovenstaande meting wat telt.
2. Via de plugin: in een sessie op Haiku 5.5 of Sonnet 5.5 een beurt, dan een beurt waarbij Jev
   een andere effort kiest, en in `/jev` kijken naar `(NN% cached)` van de tweede.

## 5. Beslismodellen (de "decider")

De router vraagt een beslismodel welke tier en effort een turn nodig heeft. Nu is dat
TypeSafe Jev, rechtstreeks of via de Vercel AI Gateway.

### 5.1 Laya op de NAS (en elke eigen server)

- Instelbare basis-URL. HTTPS volstaat; HTTP-ondersteuning is niet nodig.
- Nu blokkeert `typesafeBaseOf` elke host buiten `*.typesafe.ai`, tenzij
  `JEV_ROUTER_ALLOW_CUSTOM_BASE=1`. Beter: een expliciete lijst toegestane hosts in plaats
  van die vlag, want de vlag stuurt de sleutel naar elke host.
- Zelfondertekend certificaat op de NAS: `NODE_EXTRA_CA_CERTS` of een echt certificaat via
  een reverse proxy. In de README zetten.
- Pad en modelnaam per backend instelbaar.
- De timeout (standaard 1,5 s, maximaal 8 s) is waarschijnlijk te krap voor een NAS;
  latency meten.
- Eén codepad voor OpenRouter én Laya.

### 5.2 Confidence

- Laya en Jev geven `confidence` een andere betekenis. De router leest Laya's
  `x_jev_confidence` nu niet. Toevoegen als bron, met een vaste volgorde: eigen veld →
  `confidence` → afgeleid uit `probabilities`.
- De drempels (`DEFAULT_STICKY_CONFIDENCE`, `SUBAGENT_CONFIDENCE`) zijn voor Jev
  afgestemd. Per beslismodel eigen drempels, vastgelegd in `catalog.json` onder
  `deciders`, en gemeten (zie 7).
- De statusregel toont de bron ("Jev 97%" is niet hetzelfde als een ander model's 97%).

### 5.3 Perplexity `pplx-decider-v1.2` en `pplx-decider-flash-v1.2`

- Endpoint `https://api.perplexity.ai/v1/decisions`, verzoekvorm met `state`, `model` en
  `questions` (Noul, Choice, Score), dus dicht bij wat Jev nu krijgt. Aliassen
  `pplx-decider-latest` en `pplx-decider-flash-latest`.
- Prijs volgens de documentatie: $0,02 (27B) en $0,01 (Flash, 4B) per miljoen invoertokens;
  uitvoer gratis. Limiet 10 requests per seconde per organisatie, gedeeld over beide
  modellen.
- **Open:** de exacte veldnamen in het antwoord. Eén echte call doen vóór we bouwen.
- **Open:** werkt compaction (Noul-vragen) hiermee? Niet getest.
- De prestaties ten opzichte van Jev 1.14 zijn niet vast te stellen uit de bronnen: de
  cijfers zijn deels van Perplexity zelf en spreken elkaar tegen. We meten zelf (zie 7).

### 5.4 Beslismodellen van OpenRouter

Alleen beslismodellen, geen modellen die Claude Code zelf draait. De ladder blijft
Haiku, Sonnet, Opus en Fable.

- OpenRouter biedt Jev 1.14 (`typesafe/jev-1.14`, ook `typesafe/jev-1.13`, en de alias
  `~typesafe/jev-latest`) en meer beslismodellen, waaronder Perplexity's Decider.
- Het System One-endpoint is `https://openrouter.ai/api/v1/systemone`, dus dezelfde
  verzoekvorm als TypeSafe direct.
- **Decisions-API als optie.** Daarnaast is er een Decisions-API op
  `https://openrouter.ai/api/alpha/decisions` (en Perplexity heeft er een op
  `https://api.perplexity.ai/v1/decisions`, zie 5.3). Per route is de API-stijl
  instelbaar: `systemone` (standaard) of `decisions`, via `JEV_ROUTER_API` en in
  `catalog.json`. De stijl bepaalt pad, verzoekvorm en hoe het antwoord gelezen wordt;
  daarna loopt alles door dezelfde `decisionOf`.
  **Open:** OpenRouter's variant is "alpha", dus de vorm kan veranderen, en ik heb het
  antwoordformaat niet gezien. Eén echte call vóór we de leeslaag schrijven; tot dan is
  `systemone` de standaard en `decisions` achter de schakelaar.
- Eén `openrouter`-backend met een instelbaar model. De lijst van beschikbare
  beslismodellen komt uit OpenRouter; we filteren erop dat het een beslismodel is (het
  moet Choice en Score kunnen beantwoorden). `catalog.json` bepaalt welke we aanraden en
  met welke drempels.
- Prijs per beslissing is een tarief per token, dus de kosten van de router zelf zijn
  uit te rekenen en tonen we apart van de kosten van de turn.

### 5.5 Jev 1.14 via Command Code GOAT en OpenCode

Ook hier alleen als bron voor het beslismodel, niet als model dat de turn draait.
Dezelfde Jev 1.14, andere route en sleutel. Handig als je al zo'n abonnement hebt of als
je een tweede route als terugval wilt (zie 9).

**Command Code GOAT** ([model](https://commandcode.ai/models/jev-1-14-0),
[provider-API](https://commandcode.ai/docs/provider)):
- Model `typesafe/jev-1.14.0` (vastgepind). `typesafe/jev` is een alias en dus niet vast op
  1.14.0.
- Endpoint `https://api.commandcode.ai/provider/v1/systemone`, met een Command
  Code-sleutel.
- Alleen GOAT en hoger heeft toegang tot de Provider API; het Go-plan van $1 niet.
- Een open verzoek bij Command Code meldt dat TypeSafe's experimentele afbeeldingsinvoer en
  het `box`-vraagtype daar nog niet zijn gedocumenteerd. De router gebruikt alleen Choice
  en Score, dus dat raakt ons niet.

**OpenCode** ([docs](https://opencode.ai/docs/zen/)):
- Endpoint `https://opencode.ai/inference/systemone/v1/systemone` met een
  OpenCode-Console-sleutel. De Zen-docs noemen daarnaast
  `https://opencode.ai/zen/v1/systemone` met model-id `jev-1.13`.
- **Open:** ik vond geen pagina die Jev 1.14 aan het **Go**-plan koppelt, alleen aan
  OpenCode's Console en Zen. Of Go de toegang dekt, controleren we vóór we het erin zetten.

**Wat dit betekent voor de plugin:**
- Alle routes spreken dezelfde System One-taal. Per backend verschillen alleen de
  basis-URL, het pad, de sleutelvariabele en de model-id. Eén generieke
  `systemone`-backend die uit `catalog.json` leest welke combinaties bestaan, is genoeg;
  de hosts staan wel als allowlist in de code (zie 1, Veiligheid).
- Versie vastpinnen waar het kan (`jev-1.14.0`, `typesafe/jev-1.14`), niet op `latest`:
  de confidences waar de drempels op zijn afgestemd veranderen mee met een nieuwe release.
- Calibratie kan per route verschillen, ook voor hetzelfde model (afronding, wrapper).
  Drempels per route meten (zie 7).
- Afrekening is een tegoed of abonnement, geen tarief per token.

**Open, bij beide:**
- Gebruiksvoorwaarden: mag je een abonnement gebruiken buiten hun eigen agent, via de
  Provider-API of Console-sleutel? Lezen vóór gebruik. Gegevensbehandeling hoort daarbij:
  prompts uit eigen werk gaan naar die dienst. De pagina's van Command Code kon ik hier niet
  rechtstreeks openen; de details komen uit zoekresultaten.
- Eén echte call per route om de antwoordvorm te controleren.

### Stand van zaken stap 4

Gebouwd (`hooks/provider.ts`, `hooks/jev.ts`, `hooks/policy.ts`):
- Routes: `typesafe`, `gateway`, `openrouter`, `commandcode`, `opencode`, `laya`. Elke route heeft een
  vast adres en een eigen sleutel; die sleutel gaat alleen naar dat adres. Daarmee is de
  host-allowlist per route in de code vastgelegd (de vlag `JEV_ROUTER_ALLOW_CUSTOM_BASE` geldt nog
  alleen voor TypeSafe). `LAYA_BASE_URL` is de uitzondering: het adres van je eigen server, https,
  elke host, zonder login in de URL.
- OpenRouter, Command Code en OpenCode worden **niet** gekozen op hun sleutel alleen: die sleutels
  worden ook voor andere dingen gebruikt, en dan zouden alle prompts erheen gaan. Ze worden bij naam
  gekozen. Laya wordt wel gekozen op `LAYA_BASE_URL` alleen (die variabele is hiervoor).
- Een lijst in `JEV_ROUTER_PROVIDER` (`laya,openrouter`) wordt op volgorde geprobeerd binnen één
  tijdsbudget. Een directe fout (geweigerde verbinding, HTTP-fout) geeft de rest van de tijd aan de
  volgende; een timeout heeft het budget opgemaakt.
- Laya's `confidence` is een andere grootheid (1 min de genormaliseerde entropie). De router leest
  `x_jev_confidence` (op elk keuze- en score-antwoord, op Jevs schaal) en nooit `confidence`; ontbreekt
  die, dan wordt het getal uit de kansen afgeleid. De routeregel noemt Laya bij naam.
- Laya zonder sleutel wordt zonder `authorization`-header aangeroepen.

Via de echte plugin gecontroleerd (`scripts/probe-plugin-laya.sh`, Claude Code 2.1.306, een stand-in die
antwoordt als Laya, `FAKE_STYLE=laya`): de eerste beurt toont `Laya 99%`; de tweede vraagt haiku met
`confidence` 0,99 en `x_jev_confidence` 0,5, en de plugin houdt Sonnet aan met `kept sonnet: Laya 50% on
haiku, needs 75%`. Zou de router `confidence` lezen, dan was het model naar haiku gegaan.

Nog open:
- **Veldplaats van `x_jev_confidence`.** De bronnen zeggen dat het op elk `choice`- en `score`-antwoord
  staat; een voorbeeldantwoord heb ik niet gezien. De router leest het op het antwoordobject zelf
  (`answers.tier.x_jev_confidence`). Eén echte call naar je Laya bevestigt dat.
- **Laya's modelnaam.** Het verzoek stuurt `model: "laya"`; of de server daar iets mee doet is
  onbekend. `JEV_ROUTER_JEV_MODEL` overschrijft het.
- **OpenCode's modelnaam voor Jev** is niet bevestigd; daarom moet `JEV_ROUTER_JEV_MODEL` er gezet
  worden.
- **Drempels per beslismodel** (stap 5): de balk 0,75 en de ondergrenzen zijn op Jev afgestemd en
  gelden ongewijzigd voor Laya tot ze gemeten zijn.
- **De Decisions-API van Perplexity zelf** (`https://api.perplexity.ai/v1/decisions`) is niet
  gebouwd; die van OpenRouter wel (zie hieronder).
- **Voorwaarden** van Command Code en OpenCode voor gebruik buiten hun eigen agent zijn niet gelezen;
  lees ze voor je die routes inzet.

### Stand van zaken stap 5

**OpenRouter's Decisions API is gebouwd** (`JEV_ROUTER_API=decisions`). Uit de documentatie en de
`openrouter-decisions`-skill van OpenRouter: `POST https://openrouter.ai/api/alpha/decisions` met
`Authorization: Bearer`, een lichaam met `model`, `state` en `questions` (dezelfde twee vragen als
System One: een `choice` met `criteria` als object en een `score` met een geordende lijst), en een antwoord
met `id`, `model` (de exacte build), `provider`, `answers` en `usage.cost`. Elk antwoord heeft een `type`;
`probabilities`, `confidence` en `legend` zijn optioneel. De catalogus staat op
`GET /api/v1/models?output_modalities=decisions` en vraagt geen sleutel.
Daardoor is er weinig bij te bouwen: een ander pad, en voor een model dat geen Jev is de zekerheid alleen uit
de kansen lezen (zijn `confidence` heeft geen bekende betekenis). De routeregel noemt zo'n model bij zijn id.
**Niet gezien:** een echt antwoord. openrouter.ai is vanuit deze omgeving niet bereikbaar, dus dit is
gebouwd naar de documentatie en getest tegen een stand-in; één echte call (`npm run bench:run`) bevestigt het.
Ook niet gecontroleerd: welke ids Perplexity Decider V1.2 en Microsoft Decision-1 op OpenRouter hebben
(`npm run bench:run -- --catalog` toont ze).

**Gereedschap voor de meting** (`scripts/bench`, `tests/bench.test.ts`):
1. `npm run bench:extract` haalt de prompts die jij typte uit Claude Codes transcripts (lokaal; tool-resultaten,
   subagent-beurten, commando's en engine-tekst blijven eruit; 80 willekeurige, met een seed).
2. `npm run bench:label` laat je elke prompt een tier geven (1 haiku … 4 fable, s, u, q); de voortgang wordt na
   elk antwoord bewaard.
3. `npm run bench:run -- --cases cases.jsonl --models typesafe/jev-1.14,<ander model>` stelt de vragen van de
   router aan elk model en geeft per model: nauwkeurigheid, te laag en te hoog (te laag is het kwaliteitsrisico,
   te hoog het kostenrisico), de kalibratie (ECE en per band), hoeveel antwoorden de balk van 75% halen en
   hoe vaak die goed zijn, latency (gemiddeld en p95), kosten per duizend beslissingen en de overeenstemming
   tussen modellen. Standaard leest de tabel de zekerheid voor elk model uit de kansen, zodat de getallen
   vergelijkbaar zijn; `--confidence router` geeft wat de plugin zou lezen.
Beperkingen die ik wil noemen: het label is jouw oordeel over een prompt, niet over het resultaat van het werk; een
set van 80 prompts geeft een foutmarge van rond de tien procentpunt, dus verschillen van een paar punten
zeggen niets; en latency is die vanaf jouw machine.

## 6. Compaction

- Voorlopig Claude's eigen compaction behouden, vanwege Laya's kleinere invoerbudget.
- Nu staat compaction alleen aan voor `provider.name === "typesafe"`. Voor andere
  backends dat expliciet maken (`JEV_ROUTER_COMPACT=0` als standaard, duidelijke melding).
- Los testen vóór we het per backend aanzetten, met een begrenzing op het invoerbudget.

## 7. Meten in plaats van geloven

Er is geen onafhankelijke vergelijking van beslismodellen op "welke Claude-tier past bij
dit coderequest". We bouwen er een:
- Set echte prompts uit eigen sessies, met een handmatig gekozen juiste tier.
- Per beslismodel: nauwkeurigheid, calibratie, latency, en kosten per beslissing.
- Uitvoer met `scripts/try-prompts.mjs` als start; resultaten bij de catalogus als
  onderbouwing van de aanbevolen drempels.
- Gegevensbescherming: prompts uit eigen sessies bevatten werk. Alleen lokaal draaien, en
  geen prompts naar de repo.

## 8. Claude Pro en pluginhooks testen

Beschikbare modellen en pluginhooks op de echte client controleren: welke hooks bestaan
(`turn.start`, `turn.step`, `agent.spawn`), of het plan zichtbaar is, en wat er gebeurt
als de sessie zelf op een uitgesloten tier draait (`opusplan`, `default`, `best`). De
typedefinities komen van een vaste commit (`npm run types`); controleren of die nog kloppen.

## 9. Overig

- `plugin.json` en `homepage` wijzen nog naar de fork van Flam1ngFir3ball; aanpassen,
  met eigen versie en `CHANGELOG`.
- Terugvaldecider: Laya eerst, bij uitval OpenRouter of Jev.
- Sleutels: niet in een gedeelde `settings.json`. Controleren of `withoutKey` een andere
  sleutelvorm maskeert.
- Eén tabel voor `MODEL_OF`, prijzen, windows en `PRICE_DATE`, met een test die faalt als ze
  uit elkaar lopen. Met de catalogus wordt dit dezelfde bron.

## Volgorde

1. `catalog.json` en de lader (ophalen, cache, validatie, terugval). Alles hieronder leunt
   hierop. **Gedaan:** `hooks/catalog.ts`, `catalog.json` (spiegel van de ingebouwde
   tabellen) en `tests/catalog.test.ts`. De lader is nog niet aangesloten op
   `register.ts`: dat gebeurt in stap 2, waar de gegevens ook gebruikt worden. Een test
   zorgt dat `catalog.json` en de ingebouwde tabellen niet uit elkaar lopen.
2. Haiku 5.5 en prijstrappen; `JEV_ROUTER_PLAN` met Fable uit voor Pro; de lader
   aangesloten op `register.ts`. **Gedaan.** Prijzen komen van
   platform.claude.com/docs/en/about-claude/pricing (2026-10-21). Daarbij bleek Sonnet 5.5
   zijn cache te lezen voor $0,10, niet $0,20 (voetnoot 2 op die pagina); dat is gecorrigeerd.
   Nog open: of een effort-wijziging op Haiku 5.5 de cache kost (op 4.5 niet; niet gemeten).
3. Sync uit `/v1/models` (modellen, windows, effort). **Gedaan:** `hooks/models.ts`,
   `JEV_ROUTER_MODEL_SYNC`, `/jev`-regel `models`. Eisen en keuzes: het verzoek gaat
   alleen naar `api.anthropic.com` en heeft een API-key nodig (`ANTHROPIC_API_KEY`); een
   Pro- of Max-login heeft die niet, dan dekt `catalog.json` de modellen. Een nieuwer model
   van de line wordt pas de tier-model als het een prijs heeft (catalogus of ingebouwde
   tabel), anders blijft de router staan en meldt `/jev` dat het uit is. Een late lijst
   verandert niets in de lopende sessie. Een effort die het model niet kent wordt de
   dichtstbijzijnde die het wel kent.
4. Provider-laag: eigen host-allowlist, Laya, OpenRouter (5.4), `x_jev_confidence`. **Gedaan**
   (hieronder "Stand van zaken stap 4").
5. Meetset en benchmark; pas daarna Perplexity en drempels per beslismodel. **Gereedschap
   gebouwd** (`scripts/bench`, hieronder "Stand van zaken stap 5"); de meting zelf wacht op jouw
   gelabelde prompts en een OpenRouter-sleutel.
6. Auto-detectie van het plan, na test op de echte client.
7. Extra routes voor Jev 1.14 (Command Code GOAT, OpenCode; 5.5), als de voorwaarden het
   toestaan.
8. Compaction per backend.

## Bronnen

- Anthropic Models API: https://platform.claude.com/docs/en/api/models/list
- Perplexity Decisions API: https://docs.perplexity.ai/docs/decisions/quickstart
- Artificial Analysis Decision Index: https://benchlm.ai/benchmarks/artificial-analysis-decision-index
- OpenRouter Decision Model Rankings: https://openrouter.ai/rankings/decisions
- Command Code, Jev 1.14.0: https://commandcode.ai/models/jev-1-14-0 en https://commandcode.ai/docs/provider
- OpenCode: https://opencode.ai/docs/zen/
- OpenRouter, Jev 1.14: https://openrouter.ai/typesafe/jev-1.14 en https://openrouter.ai/docs/guides/community/jev
