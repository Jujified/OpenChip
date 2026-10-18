# Example projects

Real `.openchip` files, saved straight out of the app. Open one with
**Project → Open Project**.

They are also live test fixtures: `src/lib/projectFile.test.ts` parses every
file in this folder on each test run, so a schema change that would break a
user's saved project fails the suite here first.

| File | What it is |
| --- | --- |
| `counter-flow-exchanger.openchip` | Two straight channels running 0.4 mm apart in opposite directions — water at 60 °C against a 50% glycerol/water blend at 20 °C. A good first look at the heat-exchange estimates. |

## counter-flow-exchanger

A 40 × 60 mm two-piece chip. Both streams are 0.8 × 0.5 mm rectangular channels
at 10 µL/min through luer ports.

Worth looking at on the **Fluid Dynamics** tab: the hot stream leaves at roughly
29 °C and the cold one at roughly 56 °C, neither crossing the other's inlet, and
the glycerol side costs about seven times the pressure of the water side for the
same flow. Switching the heatmap between pressure, Reynolds number and
temperature shows all three encodings on one geometry.
