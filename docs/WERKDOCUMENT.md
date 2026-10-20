# Werkdocument: JEV-router voor Claude Code

Status: plan, nog niets gebouwd. Laatst bijgewerkt: 2026-10-20.

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
      "priceTiers": [{ "abovePromptTokens": 100000, "input": "<invullen>", "output": "<invullen>" }],
      "plans": ["pro", "max", "api"]
    }
  },
  "plans": {
    "pro": { "excludeLines": ["fable"] },
    "max": { "excludeLines": [] },
    "api": { "excludeLines": [] }
  },
  "deciders": {
    "jev": { "latest": "jev-1.14" },
    "pplx": { "latest": "pplx-decider-v1.2", "flash": "pplx-decider-flash-v1.2" }
  }
}
```

(Alleen de vorm. De prijzen van Haiku 5.5, inclusief het hogere tarief boven 100K, staan
hier bewust niet: die halen we uit Anthropics prijzenpagina voordat we ze invullen.)

**Ophalen:**
- Van `https://raw.githubusercontent.com/Daltonganger/jev-claude-router/main/catalog.json`.
- Cache op schijf, met een TTL van een paar uur, en `ETag` zodat een ongewijzigd bestand
  niets kost.
- Vaste URL met omgevingsvariabele `JEV_ROUTER_CATALOG_URL` om te overschrijven
  (eigen fork, test, lokale kopie via `file://`-pad).
- `JEV_ROUTER_CATALOG=0` zet het ophalen uit.

**Veiligheid.** De catalogus komt van buiten de code en mag daarom alleen *gegevens*
zetten, nooit gedrag dat een sleutel kan weglekken:
- Schema-validatie bij het inlezen. Een bestand dat niet klopt wordt genegeerd, de
  laatste goede cache blijft staan.
- Getallen worden begrensd (prijzen ≥ 0 en onder een plafond, windows binnen bereik).
- De catalogus mag **geen** endpoints, hosts of API-sleutels bevatten of wijzigen. De
  host-allowlist in `provider.ts` blijft in de code.
- Een afwijking die de prijs van een model meer dan een vaste factor verandert, wordt
  gemeld in de statusregel in plaats van stil toegepast. (Voorkomt dat een typefout in
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
- Dat Fable op Pro niet is inbegrepen is een aanname van de gebruiker; die staat in
  `catalog.json` zodat hij te corrigeren is zonder release.
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

### 5.4 Alle modellen van OpenRouter

Twee verschillende dingen; beide horen erbij.

**a. OpenRouter als bron van beslismodellen.** Elk beslismodel dat OpenRouter aanbiedt
(Jev-versies, Perplexity, enz.) wordt een kandidaat. Eén `openrouter`-backend met
instelbaar model; de lijst van beschikbare beslismodellen komt uit OpenRouter en
`catalog.json` bepaalt welke we aanraden en met welke drempels.

**b. OpenRouter-modellen als routeringsdoel (de modellen die Claude Code draait).**
Dan is de ladder niet meer beperkt tot Haiku, Sonnet, Opus en Fable. Ideeën:
- Prijzen en `context_length` per model uit de OpenRouter-modellenlijst, automatisch
  gesynchroniseerd (**te verifiëren:** velden en eenheden van die lijst).
- Een tier wijst naar een model in `catalog.json` in plaats van naar een vaste id.
- **Open, en bepalend:** accepteert Claude Code een niet-Claude model-id in de
  `turn.step`-herschrijving, en gaat het verzoek dan via een gateway (zoals
  `ANTHROPIC_BASE_URL` naar OpenRouter)? Dat moet op jouw client getest worden. Zo niet,
  dan is (b) niet mogelijk binnen een plugin en blijft het bij (a).
- Prompt caching, effort en tool-gedrag verschillen per model; de kostenberekening
  (`write1h`, `read`) gaat daar niet vanzelf van uit. Per model aangeven wat het
  ondersteunt, anders geen cache-afweging.

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
   hierop.
2. Haiku 5.5 en prijstrappen; `JEV_ROUTER_PLAN` met Fable uit voor Pro.
3. Sync uit `/v1/models` (modellen, windows, effort).
4. Provider-laag: eigen host-allowlist, Laya, OpenRouter (a), `x_jev_confidence`.
5. Meetset en benchmark; pas daarna Perplexity en drempels per beslismodel.
6. Auto-detectie van het plan, na test op de echte client.
7. OpenRouter als routeringsdoel (b), alleen als de test in 5.4 het toelaat.
8. Compaction per backend.

## Bronnen

- Anthropic Models API: https://platform.claude.com/docs/en/api/models/list
- Perplexity Decisions API: https://docs.perplexity.ai/docs/decisions/quickstart
- Artificial Analysis Decision Index: https://benchlm.ai/benchmarks/artificial-analysis-decision-index
- OpenRouter Decision Model Rankings: https://openrouter.ai/rankings/decisions
