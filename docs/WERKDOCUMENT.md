# Werkdocument: JEV-router voor Claude Code

Status: stap 1 tot en met 3 gebouwd (zie Volgorde), de rest is plan. Laatst bijgewerkt: 2026-10-20.

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

Meten, in twee stappen:
1. `ANTHROPIC_API_KEY=… npm run measure-effort-cache` (script `scripts/measure-effort-cache.mjs`,
   een paar cent). Vier requests met dezelfde lange eerste boodschap: effort laag (schrijft),
   nog eens laag (controle), top-level hoog, per-bericht hoog. Het zegt per variant of de cache
   blijft, of de hele prefix opnieuw geschreven wordt. Ook te draaien voor Sonnet 5.5 en Opus 5.5.
2. Wat Claude Code zelf doet: in een echte sessie op Haiku 5.5, een beurt, dan een beurt waarbij
   Jev een andere effort kiest, en in `/jev` kijken naar `(NN% cached)` van de tweede. Blijft dat
   rond het niveau van de eerste, dan kost de wijziging niets; zakt het naar bijna 0, dan stuurt
   Claude Code de top-level waarde en geldt voor Haiku 5.5 hetzelfde als voor Sonnet 5 (en moet
   `holdsSonnetEffort` ook voor Haiku gelden). Stap 1 zegt wat de API kan; stap 2 wat Claude
   Code gebruikt.

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
4. Provider-laag: eigen host-allowlist, Laya, OpenRouter (5.4), `x_jev_confidence`.
5. Meetset en benchmark; pas daarna Perplexity en drempels per beslismodel.
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
