# XER Checker

A small command-line tool that reads Primavera P6 schedule exports (.xer),
flags rows it cannot trust, runs three schedule checks (missing links,
negative float, high float), and writes one static HTML report.

## Usage

```
npm install
npm run check     # reads every .xer in data/, prints findings, writes report.html
npm test          # runs the tests
```

## Sources

Both files come from a publicly shared Google Drive folder of sample P6
schedules, found via Reddit:
https://drive.google.com/drive/folders/1ge9H0n2Nwjge17_P3TQKNPhARbThoR3R
Original author and license unknown. Included unmodified for this exercise
only; removed on request.

| File | Size (bytes) | P6 version (ERMHDR) | SHA-256 |
|---|---|---|---|
| `data/CCA_R03_dt_24Oct11SC.xer` | 30,113,528 | 6.0 | `8f00d46101be2c56e23f761bd9fadfb10471ea77c79cb604f0510c4922a9e7d8` |
| `data/Expressway_Project.xer` | 1,663,465 | 7.0 | `f8efbb5305d3ce36be968ea5c736da194ce144ebad90781191082a43bc886e00` |

To verify:

```
shasum -a 256 data/*.xer
```
