# Site Performance Baseline

- Generated: 2026-01-28 11:14:57
- Commit: de1140d
- Host: BITOPIA


## Build (Next route sizes)

```text
pnpm exit code: 0
   ▲ Next.js 15.5.5 (Turbopack)
   - Experiments (use with caution):
     · serverActions
     · middlewareClientMaxBodySize: "20mb"

   Creating an optimized production build ...
node.exe :  ⚠ Webpack is configured while Turbopack is not, which may cause problems.
At C:\Users\xenon\AppData\Roaming\npm\pnpm.ps1:24 char:5
+     & "node$exe"  "$basedir/node_modules/pnpm/bin/pnpm.cjs" $args
+     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: ( ⚠ Webpack is c...cause problems.:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
 
 ⚠ See instructions if you need to configure Turbopack:
  https://nextjs.org/docs/app/api-reference/next-config-js/turbopack

[baseline-browser-mapping] The data in this module is over two months old.  To ensure accurate Baseline data, please 
update: `npm i baseline-browser-mapping@latest -D`
 ✓ Finished writing to disk in 205ms
 ✓ Compiled successfully in 3.6s
   Skipping linting
   Checking validity of types ...
 ⚠ TypeScript project references are not fully supported. Attempting to build in incremental mode.
   Collecting page data ...
 ⚠ Using edge runtime on a page currently disables static generation for that page
   Generating static pages (0/57) ...
   Generating static pages (14/57) 
   Generating static pages (28/57) 
   Generating static pages (42/57) 
 ✓ Generating static pages (57/57)
   Finalizing page optimization ...
   Collecting build traces ...

Route (app)                                                    Size  First Load JS
┌ ○ /                                                           0 B         154 kB
├ ○ /_not-found                                                 0 B         117 kB
├ ○ /about                                                      0 B         143 kB
├ ○ /admin/estimates                                            0 B         117 kB
├ ƒ /admin/login                                              937 B         118 kB
├ ○ /admin/payments                                             0 B         117 kB
├ ○ /admin/quotes                                               0 B         117 kB
├ ƒ /api/admin/appointments                                     0 B            0 B
├ ƒ /api/admin/session                                          0 B            0 B
├ ƒ /api/chat                                                   0 B            0 B
├ ƒ /api/chat/actions                                           0 B            0 B
├ ƒ /api/chat/book                                              0 B            0 B
├ ƒ /api/chat/stt                                               0 B            0 B
├ ƒ /api/chat/tts                                               0 B            0 B
├ ƒ /api/healthz                                                0 B            0 B
├ ƒ /api/owner-chat                                             0 B            0 B
├ ƒ /api/team/access/members                                    0 B            0 B
├ ƒ /api/team/access/members/[memberId]                         0 B            0 B
├ ƒ /api/team/access/members/[memberId]/delete                  0 B            0 B
├ ƒ /api/team/access/roles                                      0 B            0 B
├ ƒ /api/team/access/sales-settings                             0 B            0 B
├ ƒ /api/team/appointments/notes                                0 B            0 B
├ ƒ /api/team/appointments/status                               0 B            0 B
├ ƒ /api/team/calls/coaching/[callRecordId]                     0 B            0 B
├ ƒ /api/team/calls/start                                       0 B            0 B
├ ƒ /api/team/commissions/payout-runs                           0 B            0 B
├ ƒ /api/team/commissions/payout-runs/[payoutRunId]/export      0 B            0 B
├ ƒ /api/team/commissions/settings                              0 B            0 B
├ ƒ /api/team/contacts                                          0 B            0 B
├ ƒ /api/team/contacts/assignee                                 0 B            0 B
├ ƒ /api/team/contacts/name                                     0 B            0 B
├ ƒ /api/team/contacts/notes                                    0 B            0 B
├ ƒ /api/team/contacts/notes/[noteId]                           0 B            0 B
├ ƒ /api/team/contacts/pipeline                                 0 B            0 B
├ ƒ /api/team/contacts/quote-photos                             0 B            0 B
├ ƒ /api/team/contacts/reminders                                0 B            0 B
├ ƒ /api/team/contacts/reminders/[taskId]                       0 B            0 B
├ ƒ /api/team/contacts/summary                                  0 B            0 B
├ ƒ /api/team/expenses                                          0 B            0 B
├ ƒ /api/team/expenses/[expenseId]/receipt                      0 B            0 B
├ ƒ /api/team/flash/clear                                       0 B            0 B
├ ƒ /api/team/inbox/export                                      0 B            0 B
├ ƒ /api/team/inbox/media/[messageId]/[index]                   0 B            0 B
├ ƒ /api/team/sales/disposition                                 0 B            0 B
├ ƒ /api/team/sales/reset                                       0 B            0 B
├ ƒ /api/team/sales/touch                                       0 B            0 B
├ ○ /areas                                                  2.16 kB         144 kB
├ ● /areas/[slug]                                               0 B         143 kB
├   ├ /areas/cherokee-county
├   └ /areas/woodstock
├ ○ /blog                                                       0 B         142 kB
├ ƒ /blog/[slug]                                                0 B         142 kB
├ ○ /book                                                   1.29 kB         153 kB
├ ○ /contact                                                    0 B         143 kB
├ ○ /contractors                                                0 B         163 kB
├ ○ /crew                                                       0 B         117 kB
├ ƒ /crew/login                                               912 B         118 kB
├ ƒ /estimate                                                   0 B         163 kB
├ ○ /gallery                                                    0 B         143 kB
├ ƒ /opengraph-image                                            0 B            0 B
├ ƒ /partners                                                   0 B         121 kB
├ ƒ /partners/auth                                              0 B            0 B
├ ƒ /partners/book                                              0 B         121 kB
├ ƒ /partners/bookings                                          0 B         121 kB
├ ƒ /partners/login                                             0 B         121 kB
├ ƒ /partners/logout                                            0 B            0 B
├ ƒ /partners/properties                                        0 B         121 kB
├ ƒ /partners/settings                                          0 B         121 kB
├ ○ /pricing                                                5.46 kB         148 kB
├ ○ /privacy                                                    0 B         142 kB
├ ƒ /quote/[token]                                              0 B         121 kB
├ ○ /reviews                                                    0 B         143 kB
├ ○ /robots.txt                                                 0 B            0 B
├ ƒ /schedule                                               1.19 kB         118 kB
├ ○ /services                                                   0 B         142 kB
├ ● /services/[slug]                                            0 B         143 kB
├   ├ /services/appliances
├   ├ /services/construction-debris
├   ├ /services/furniture
├   └ [+3 more paths]
├ ○ /sitemap.xml                                                0 B            0 B
├ ƒ /team                                                   45.5 kB         175 kB
├ ƒ /team/auth                                                  0 B            0 B
├ ƒ /team/instant-quotes/[id]                                 769 B         118 kB
├ ƒ /team/login                                             4.19 kB         121 kB
├ ○ /terms                                                      0 B         142 kB
└ ƒ /twitter-image                                              0 B            0 B
+ First Load JS shared by all                                134 kB
  ├ chunks/089ea05bcda13214.js                              58.9 kB
  └ chunks/86d4490bf81ccd37.js                              17.1 kB
  ├ chunks/c1df830afa87be2b.js                              13.1 kB
  ├ chunks/7fca7135682e4d68.css                             13.9 kB
  └ other shared chunks (total)                             30.6 kB


ƒ Middleware                                                38.4 kB

○  (Static)   prerendered as static content
●  (SSG)      prerendered as static HTML (uses generateStaticParams)
ƒ  (Dynamic)  server-rendered on demand
```


## Client bundles (.next/static/chunks)

- Path: apps/site/.next/static/chunks
- Files matched: 42
- Total bytes: 1,688,647

```text
Top files:
295,450  apps\site\.next\static\chunks\2e7c1906fc20f065.js
193,768  apps\site\.next\static\chunks\c118664c2f388578.js
187,523  apps\site\.next\static\chunks\089ea05bcda13214.js
154,021  apps\site\.next\static\chunks\bccf26404051f6bc.js
112,594  apps\site\.next\static\chunks\a6dad97d9634a72d.js
105,515  apps\site\.next\static\chunks\7fca7135682e4d68.css
79,119  apps\site\.next\static\chunks\40c544d598660f14.js
64,596  apps\site\.next\static\chunks\86d4490bf81ccd37.js
45,909  apps\site\.next\static\chunks\eae5c177781c2e41.js
41,693  apps\site\.next\static\chunks\c1df830afa87be2b.js
37,827  apps\site\.next\static\chunks\46ec77ad77e3aca3.js
37,173  apps\site\.next\static\chunks\e5aef7df2ca12576.js
36,746  apps\site\.next\static\chunks\d8fd32c69b5d418b.js
36,690  apps\site\.next\static\chunks\14ce04b2a7704130.js
36,690  apps\site\.next\static\chunks\6a44f83b08ff882d.js
32,444  apps\site\.next\static\chunks\0850e9e9a3cf1ccc.js
20,853  apps\site\.next\static\chunks\585b8699858bb2f9.js
20,424  apps\site\.next\static\chunks\aecbb006620ceb4f.js
20,089  apps\site\.next\static\chunks\50e3d84a52deaf3c.js
14,785  apps\site\.next\static\chunks\61855a8f0c8f4799.js
```


## Public images (apps/site/public/images)

- Path: apps/site/public/images
- Files matched: 22
- Total bytes: 18,205,801

```text
Top files:
3,953,081  apps\site\public\images\services\Yarddebris.png
3,154,517  apps\site\public\images\gallery\showcase\after.png
2,581,969  apps\site\public\images\services\Junkremoval.png
2,104,927  apps\site\public\images\gallery\showcase\Sidewalk_beforeafter_16x9.png
1,482,803  apps\site\public\images\gallery\showcase\home-after.png
1,391,569  apps\site\public\images\gallery\showcase\BrickWall_beforeafter_16x9.png
906,683  apps\site\public\images\gallery\trailer_16x9.png
574,330  apps\site\public\images\services\Yarddebris.jpg
442,474  apps\site\public\images\gallery\garage_before_after_split_1080p.jpg
439,284  apps\site\public\images\gallery\showcase\garage_before_aligned_16x9_1080p.jpg
433,104  apps\site\public\images\gallery\showcase\commercial-after.png
271,767  apps\site\public\images\gallery\showcase\garage_after_aligned_16x9_1080p.jpg
215,195  apps\site\public\images\services\Junkremoval.jpg
144,142  apps\site\public\images\gallery\trailer_16x9.jpg
102,604  apps\site\public\images\brand\Stonegatelogo.png
3,571  apps\site\public\images\hero\crew-softwash.svg
633  apps\site\public\images\services\junk-yard.jpg
631  apps\site\public\images\services\junk-single.jpg
631  apps\site\public\images\services\junk-construction.jpg
629  apps\site\public\images\services\junk-appliances.jpg
```

