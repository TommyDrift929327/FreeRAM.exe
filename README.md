# FreeRAM

Application Windows 11 (Electron) de surveillance de la mémoire vive, du processeur, du GPU et des températures, avec fermeture contrôlée des applications et vérification **5 secondes** après la demande.

Interface sombre de style gaming, entièrement en français, séparée en HTML / CSS / JavaScript et configurable par fichiers JSON.

> **Honnêteté des mesures** : FreeRAM n'invente aucune valeur. Une température ou une donnée GPU indisponible est affichée « Indisponible ». La mémoire « Disponible » de Windows inclut la mémoire en veille ; elle ne représente donc pas intégralement de la RAM immédiatement récupérable.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Installation et commandes](#installation-et-commandes)
- [Mises à jour et canaux](#mises-à-jour-et-canaux)
- [Compilation locale depuis l'application](#compilation-locale-depuis-lapplication)
- [Utilisation](#utilisation)
- [Sémantique de fermeture](#sémantique-de-fermeture)
- [Capteurs, administration et limites](#capteurs-administration-et-limites)
- [Architecture](#architecture)
- [Personnalisation](#personnalisation)
- [Sécurité](#sécurité)
- [Tests](#tests)
- [Journaux et dépannage](#journaux-et-dépannage)
- [Livrables](#livrables)

---

## Fonctionnalités

- **RAM** : total, utilisé, disponible, pourcentage, barre de progression.
- **Somme des working sets** des processus, affichée séparément : ce n'est **pas** la RAM récupérable.
- **CPU** : charge globale calculée par delta de temps processeur.
- **GPU** : utilisation via les compteurs de performance Windows ; VRAM si le pilote l'expose.
- **Températures CPU / GPU** : uniquement si un fournisseur WMI compatible est présent (LibreHardwareMonitor ou OpenHardwareMonitor). Sinon « Indisponible ».
- **Top 256 des processus** par mémoire, avec nom d'exécutable réel, PID et mémoire.
- **Vue groupée par application** (par défaut) ou vue processus individuels ; un groupe peut être déplié pour ne fermer qu'un PID.
- **Recherche** instantanée, sélection de **256 processus maximum**.
- **Fermeture sûre** : confirmation explicite, avertissement sur les données non enregistrées, protection des processus critiques.
- **Vérification à 5 s** par nom d'exécutable et PID, jamais par titre de fenêtre.
- **Statuts sans ambiguïté** : Fermée, Toujours active, Relancée automatiquement, Erreur d'accès.
- **Différentiel de RAM** avant / après la fermeture.
- **« Libérer la RAM »** : vide les working sets sélectionnés (ou tous les processus éligibles), sans fermer d'application.
- **Création du raccourci Bureau** depuis les réglages, plus script PowerShell autonome.
- **Mises à jour GitHub** stable ou bêta, vérification silencieuse toutes les 24 h et vérification manuelle.
- **Compilation locale** du setup NSIS et du portable depuis les réglages, avec sauvegarde de l'ancienne version.
- **Thème et mise en page personnalisables** sans reconstruire l'application.

---

## Installation et commandes

### Prérequis

- Windows 11 x64.
- Node.js 22 ou supérieur (testé avec Electron 45.1.0).
- PowerShell 5.1 (présent par défaut).

> Dans PowerShell, utilisez `npm.cmd` : la stratégie d'exécution bloque souvent `npm.ps1`.

### Développement

```powershell
cd "C:\chemin\vers\FreeRAM.exe"
npm.cmd install
npm.cmd test
npm.cmd run test:updates
npm.cmd run test:close
npm.cmd start
```

Mode développement avec outils de développement :

```powershell
npm.cmd run debug
```

`npm.cmd run debug` ouvre Chromium DevTools et un port CDP local sur `9222`.

### Génération du paquet Windows

```powershell
npm.cmd run dist:dir     # dossier non installé : release\win-unpacked
npm.cmd run dist         # setup NSIS + portable, canal défini dans electron-builder.yml
npm.cmd run dist:stable  # force latest.yml
npm.cmd run dist:beta    # force beta.yml
```

Ces commandes ne publient rien. La publication est faite uniquement par GitHub Actions lors d'un tag `v*`.

Après un build stable, `release\latest.yml` et une copie `release\beta.yml` sont nécessaires. Après un build bêta, seul `beta.yml` doit être publié. Le script `scripts\prepare-release-assets.js` vérifie ces fichiers.

### Raccourci Bureau

```powershell
npm.cmd run shortcut
```

Le script cherche automatiquement, dans cet ordre :

1. `release\win-unpacked\FreeRAM.exe` ;
2. `FreeRAM.exe` à la racine du projet ;
3. `%LOCALAPPDATA%\Programs\FreeRAM\FreeRAM.exe` (installation NSIS) ;
4. `%ProgramFiles%\FreeRAM\FreeRAM.exe`.

Cible explicite possible :

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1 `
  -TargetPath "$env:LOCALAPPDATA\Programs\FreeRAM\FreeRAM.exe"
```

Le raccourci est créé ici :

```text
%USERPROFILE%\Desktop\FreeRAM.lnk
```

### Installation de l'installeur

```powershell
.\release\FreeRAM-1.1.0-beta.1-setup.exe
```

Installation par utilisateur (aucun droit administrateur requis), avec raccourcis Bureau et menu Démarrer. La version portable ne s'installe pas :

```powershell
.\release\FreeRAM-1.1.0-beta.1-portable.exe
```

---

## Mises à jour et canaux

FreeRAM utilise `electron-updater` avec les releases GitHub. Deux canaux sont séparés :

| Canal | Fichier de mise à jour | Versions acceptées |
| --- | --- | --- |
| **Stable** | `latest.yml` | Uniquement les versions sans suffixe, par exemple `1.1.0` |
| **Bêta** | `beta.yml` | Versions stables et versions `-beta.N` uniquement |

Règles appliquées par l'application :

- une version `-beta.N`, `-alpha.N` ou `-rc.N` est **toujours refusée** sur le canal stable ;
- une version `-alpha.N` ou `-rc.N` est refusée sur le canal bêta ;
- le canal est mémorisé dans `%APPDATA%\FreeRAM\update-preferences.json` ;
- la vérification silencieuse a lieu 30 secondes après le démarrage, puis toutes les 24 heures ;
- **aucun téléchargement automatique** : l'utilisateur clique sur « Télécharger » ;
- **aucune installation automatique** : un dernier bouton demande confirmation avant de redémarrer ;
- les erreurs et la progression sont affichées dans **Paramètres → Mises à jour**.

La mise à jour automatique ne fonctionne que pour une **installation NSIS**. La version portable et le dossier `release\win-unpacked` affichent une explication : il faut télécharger la nouvelle version depuis GitHub.

> La version 1.0.0 déjà installée ne contient pas `electron-updater`. La première installation de `1.1.0-beta.1` doit donc être faite manuellement avec le setup. Les versions suivantes peuvent être mises à jour depuis l'application.

### Publier une version

Le workflow `.github/workflows/release.yml` se déclenche sur un tag `v*`. Il vérifie que le tag correspond exactement à `package.json`, exécute les tests, compile le setup et le portable, vérifie `latest.yml` / `beta.yml`, puis crée la release avec `gh`.

```powershell
# Bêta : package.json doit contenir 1.1.0-beta.1
git tag v1.1.0-beta.1
git push origin v1.1.0-beta.1

# Stable : package.json doit contenir 1.1.0
git tag v1.1.0
git push origin v1.1.0
```

Les tags bêta sont publiés avec `--prerelease`. Le workflow ne modifie ni ne supprime aucune release existante. Il ajoute seulement une nouvelle release.

Dans **Settings → Actions → General → Workflow permissions**, sélectionnez **Read and write permissions** pour que `GITHUB_TOKEN` puisse créer la release. Aucun token GitHub n'est présent dans le code client.

---

## Compilation locale depuis l'application

Le bouton **Compiler FreeRAM** est disponible dans les paramètres lorsque FreeRAM est lancé depuis le dossier source. Il vérifie :

1. la présence de `package.json`, `main.js`, `src\main` et `scripts\build-and-relaunch.js` ;
2. Node.js et npm dans le `PATH` ;
3. `node_modules\electron-builder`.

Ensuite, FreeRAM se ferme et un helper détaché :

1. compile dans un dossier temporaire `release.staging-*` ;
2. vérifie la présence et la taille du setup, du portable, du blockmap et du fichier `.yml` ;
3. sauvegarde l'ancien `release` dans `release.previous` ;
4. remplace `release` uniquement en cas de succès ;
5. relance automatiquement la nouvelle version.

En cas d'échec, `release` n'est pas remplacé, l'ancienne version est relancée et l'erreur est conservée dans le statut et le journal `%APPDATA%\FreeRAM\logs\build-*.log`. Depuis une version installée sans code source, le bouton explique que la compilation locale n'est pas disponible.

---

## Utilisation

1. Lancez FreeRAM par le raccourci Bureau, le menu Démarrer ou une installation NSIS.
2. Consultez la RAM, le CPU, le GPU et les températures.
3. Dans la liste, recherchez une application, sélectionnez jusqu'à 256 processus.
4. Cliquez sur **Fermer la sélection**.
5. Lisez la confirmation : elle rappelle le risque de perte de données non enregistrées.
6. Pendant 5 secondes, la progression et le compte à rebours s'affichent.
7. Le résultat indique, pour chaque application, son statut et l'écart de RAM avant / après.

Un processus protégé est verrouillé dans l'interface et revalidé côté processus principal : la protection ne peut pas être contournée en modifiant le renderer.

---

## Sémantique de fermeture

La fermeture suit toujours le même ordre :

1. **Revalidation serveur** des PID, de la liste protégée et de la limite de 256.
2. **Instantané avant** : mémoire système et somme des working sets.
3. **Fermeture normale** : envoi de `WM_CLOSE` aux fenêtres des PID sélectionnés (y compris certaines fenêtres masquées avec titre).
4. **Attente de 5 secondes** à partir de la demande de fermeture (valeur par défaut, configurable).
5. **Vérification** : nouvelle lecture `tasklist`, puis dates de démarrage via `Get-Process` pour distinguer une relance d'une instance préexistante.
6. **Terminaison forcée** uniquement des PID encore présents après ces 5 secondes, si l'option est active.
7. **Nouvelle vérification** environ 1,5 s après la terminaison forcée, puis **instantané après**.

Les quatre statuts affichés :

| Statut | Signification |
| --- | --- |
| **Fermée** | Le PID sélectionné n'existe plus à la vérification finale. |
| **Toujours active** | Le PID est encore présent après la procédure. Aucune conclusion hâtive n'est tirée. |
| **Relancée automatiquement** | Le PID d'origine a disparu, mais une nouvelle instance du même exécutable a démarré après la demande. Elle n'est pas fermée automatiquement. |
| **Erreur d'accès** | Windows a refusé l'action (souvent le code 5). Relancer FreeRAM en administrateur peut débloquer le cas. |

Points importants :

- Le titre de fenêtre n'est **jamais** utilisé pour identifier un processus.
- Une application multi-processus est regroupée par nom d'exécutable ; les PID réellement sélectionnés restent visibles.
- Des instances non sélectionnées du même exécutable sont signalées comme toujours actives : FreeRAM ne prétend pas avoir fermé toute l'application.
- La différence de RAM affichée est une mesure réelle, pas une promesse de gain.

---

## Capteurs, administration et limites

### GPU

- Utilisation lue dans `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine`.
- Mémoire GPU lue dans `GPUAdapterMemory` lorsque disponible.
- Aucun droit administrateur requis.
- Selon le pilote et la carte, la VRAM totale peut être absente : l'interface n'affiche alors que la valeur disponible, sans estimation inventée.

### Températures

Windows n'expose pas de température CPU/GPU fiable sans pilote noyau ou outil tiers. FreeRAM interroge le fournisseur WMI de :

- **LibreHardwareMonitor** (`root\LibreHardwareMonitor`) ;
- **OpenHardwareMonitor** (`root\OpenHardwareMonitor`).

Sans l'un de ces outils lancé, les températures CPU et GPU restent « Indisponible ». La température ACPI (`MSAcpi_ThermalZoneTemperature`) est utilisée uniquement comme température système, jamais comme température CPU ou GPU.

### Droits administrateur

- La lecture de la RAM, du CPU, du GPU et de la liste des processus fonctionne sans élévation.
- Certaines fermetures ou terminaisons forcées échouent avec « Erreur d'accès » sans élévation, notamment pour les applications lancées par un autre utilisateur ou avec des privilèges élevés.
- Le bouton **Relancer en administrateur** déclenche UAC et relance FreeRAM avec le paramètre interne `--freeram-elevated`.
- FreeRAM ne demande jamais d'élévation silencieuse et ne contourne pas UAC.
- Les services (session 0), les PID ≤ 4, les processus système connus, FreeRAM lui-même et ses processus enfants sont protégés.

### Honnêteté mémoire

- « Utilisé » = total − disponible.
- « Disponible » correspond à la mémoire physique disponible de Windows, listes de pages en veille incluses.
- La somme des working sets des processus n'est pas égale à la RAM récupérable : une partie est partagée, une partie peut être remise en page, et vider un working set peut simplement déplacer des pages vers le fichier d'échange.
- **Libérer la RAM** appelle `EmptyWorkingSet` : cela peut réduire temporairement l'empreinte, au prix d'un ralentissement possible des applications concernées. Aucun gain n'est garanti.

---

## Architecture

```text
FreeRAM.exe\
├─ main.js                     Cycle de vie Electron, fenêtre, sécurité, démarrage
├─ preload.js                  Pont IPC minimal et figé (contextBridge)
├─ package.json                Scripts et versions Electron / electron-builder
├─ electron-builder.yml        Cibles NSIS + portable, asarUnpack
├─ build\                      Icônes générées (ICO multi-tailles, PNG)
├─ config\
│  ├─ app.config.json          Fréquences, limites, délai de vérification
│  └─ protected-processes.json Liste de protection + section « extra »
├─ src\main\
│  ├─ monitor.js               Boucles d'échantillonnage et diffusion d'événements
│  ├─ memory.js                RAM système et charge CPU
│  ├─ processes.js             tasklist CSV, protection, validation, top 256
│  ├─ win32.js                 WM_CLOSE, terminaison, dates de démarrage, EmptyWorkingSet
│  ├─ closer.js                Orchestration fermeture + vérification à 5 s
│  ├─ sensors.js               Sampler PowerShell persistant GPU / températures
│  ├─ powershell.js            Exécution PowerShell, encodage UTF-8, timeouts
│  ├─ config.js                Fusion defaults ← config embarquée ← surcharge utilisateur
│  ├─ ipc.js                   Contrats IPC validés côté main
│  ├─ updater.js               electron-updater, canaux et vérification périodique
│  ├─ update-policy.js         Règles pures stable / bêta
│  ├─ build.js                 Vérification de l'environnement et lancement du helper
│  ├─ build-policy.js          Noms et validation des artefacts de compilation
│  ├─ shortcuts.js             Raccourci Bureau via WScript.Shell
│  └─ logger.js                Journal fichier UTF-8
├─ src\renderer\
│  ├─ index.html               Structure de l'interface et modales
│  ├─ css\theme.css            Variables, couleurs, typographie
│  ├─ css\layout.css           Grille, en-tête, panneaux, responsive
│  ├─ css\components.css       Boutons, jauges, listes, modales, toasts
│  ├─ js\app.js                État, rendu, sélection, fermeture, réglages
│  ├─ js\format.js             Formatage octets / pourcentages / durées
│  └─ assets\logo.png          Logo de l'interface
├─ scripts\
│  ├─ test-core.js             10 tests cœur
│  ├─ test-updates.js          Tests des canaux et des artefacts
│  ├─ test-close.js            7 tests d'intégration de fermeture
│  ├─ build-and-relaunch.js    Compilation staging, sauvegarde et relance
│  ├─ prepare-release-assets.js Vérification latest.yml / beta.yml
│  ├─ generate-icon.js         Génération des icônes
│  ├─ create-shortcut.ps1      Raccourci Bureau autonome
│  ├─ cdp-probe.js             Inspection DOM / capture CDP
│  └─ cdp-eval.js              Évaluation CDP
├─ .github\workflows\release.yml Tests, build et release sur tag v*
├─ release\                    Paquets générés (non versionné)
└─ release.previous\           Sauvegarde du dernier build réussi (non versionnée)
```

Le renderer ne reçoit jamais Node.js. Il appelle uniquement les méthodes exposées par `preload.js`. Les décisions sensibles (PID réels, protection, maximum 256, force) sont toutes revérifiées dans le processus principal.

---

## Personnalisation

### Configuration principale

Fichier embarqué :

```text
config\app.config.json
```

Version packagée :

```text
release\win-unpacked\resources\app.asar.unpacked\config\app.config.json
```

Surcharge utilisateur optionnelle, prioritaire, à créer manuellement :

```text
%APPDATA%\FreeRAM\config\app.config.json
```

Seules les clés présentes sont fusionnées ; le reste conserve les valeurs par défaut. Exemple :

```json
{
  "refresh": {
    "memoryMs": 1500,
    "processesMs": 3000,
    "gpuMs": 4000
  },
  "processes": {
    "topCount": 20,
    "defaultView": "processes"
  },
  "closing": {
    "verificationDelayMs": 5000,
    "forceAfterDelay": true
  }
}
```

Les valeurs sont bornées par `src/main/config.js` (par exemple `maxSelection` reste plafonné à 256, et le délai de vérification entre 1 000 et 30 000 ms). Un JSON invalide n'empêche pas le démarrage : l'erreur est journalisée et les valeurs précédentes sont conservées.

### Protection

```text
config\protected-processes.json
```

- `protected` : liste fournie avec l'application.
- `extra` : ajouts simples, par exemple `"monapp.exe"`.
- Surcharge utilisateur : `%APPDATA%\FreeRAM\config\protected-processes.json`, avec les mêmes tableaux. Les entrées sont fusionnées, jamais retirées.

La comparaison est insensible à la casse et au suffixe `.exe`.

### Interface

Version packagée, les fichiers sont dépaquetés et donc modifiables directement :

```text
release\win-unpacked\resources\app.asar.unpacked\src\renderer\
```

- couleurs et variables : `css\theme.css` ;
- grille et dispositions : `css\layout.css` ;
- composants : `css\components.css` ;
- logique et textes : `js\app.js`, `index.html`.

Après modification, fermez et relancez FreeRAM. En développement, les fichiers de `src\renderer\` sont utilisés directement.

---

## Sécurité

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- `webviewTag: false`
- `webSecurity: true`
- Aucune permission navigateur accordée (`setPermissionRequestHandler` / `setPermissionCheckHandler`).
- Ouverture de nouvelles fenêtres refusée ; navigation externe bloquée.
- Menu applicatif supprimé.
- API preload figée, sans fonction générique de type `invoke(channel, ...)`.
- Contrôle de l'expéditeur IPC : seules les pages `file://` du renderer FreeRAM sont acceptées.
- Validation systématique des PID et de la protection côté main.
- Verrou mono-instance ; le mode élevé utilise `--freeram-elevated` pour éviter un blocage entre l'ancienne et la nouvelle instance.
- Aucune télémétrie, aucun compte utilisateur et aucune donnée personnelle envoyée.
- Seul accès réseau : la vérification des releases GitHub et le téléchargement d'une mise à jour après action de l'utilisateur. Aucun token n'est embarqué ; le workflow GitHub Actions utilise `GITHUB_TOKEN`.

---

## Tests

```powershell
npm.cmd test
npm.cmd run test:updates
npm.cmd run test:close
# ou en une fois :
npm.cmd run test:all
```

Résultats obtenus sur cette machine (Windows 11) :

- `scripts/test-core.js` : **10/10** — configuration, protection, mémoire, parsing `tasklist`, lecture réelle des processus, sampler GPU, températures honnêtement indisponibles.
- `scripts/test-updates.js` : tests des canaux stable/bêta, refus des pré-releases sur stable, noms `latest.yml` / `beta.yml`, URL GitHub et validation des artefacts.
- `scripts/test-close.js` : **7/7** — fermeture gracieuse, processus sans fenêtre, terminaison forcée, détection de relance, refus des protégés, limite de 256 / PID inconnu, `EmptyWorkingSet`.

Les tests de fermeture compilent une petite application de test dans `%TEMP%` et la nettoient ensuite. En cas de résidu :

```powershell
taskkill /F /IM FreeRAMTestApp.exe
```

---

## Journaux et dépannage

Journal :

```text
%APPDATA%\FreeRAM\logs\freeram.log
```

Le journal est en UTF-8. L'affichage de certains caractères accentués peut être incorrect dans une ancienne console Windows, mais le fichier reste lisible dans un éditeur UTF-8.

### L'application ne démarre pas

Vérifiez qu'aucune instance ne tourne déjà (verrou mono-instance), puis lancez depuis un terminal :

```powershell
& ".\release\win-unpacked\FreeRAM.exe"
```

### Le raccourci ne trouve plus la cible

Si `release\win-unpacked` a été déplacé ou supprimé, recréez le raccourci :

```powershell
npm.cmd run shortcut
```

### Températures « Indisponible »

C'est le comportement normal sans LibreHardwareMonitor ou OpenHardwareMonitor lancé. FreeRAM n'estime pas les températures.

### « Erreur d'accès »

Utilisez **Relancer en administrateur** dans les réglages ou lancez l'exécutable avec « Exécuter en tant qu'administrateur ». Certaines applications système restent protégées même en administrateur.

### Windows SmartScreen

Les exécutables générés ne sont pas signés. SmartScreen peut afficher un avertissement. Pour un déploiement réel, signez l'installeur et l'exécutable avec un certificat de signature de code.

### `npm.ps1` bloqué

Utilisez toujours `npm.cmd` dans PowerShell.

---

## Livrables

```text
release\win-unpacked\FreeRAM.exe        Application non installée
release\FreeRAM-<version>-setup.exe     Installeur NSIS (utilisateur)
release\FreeRAM-<version>-portable.exe  Version portable
release\latest.yml / beta.yml           Métadonnées de mise à jour
%USERPROFILE%\Desktop\FreeRAM.lnk       Raccourci Bureau
```

Les chemins personnels ne sont pas versionnés. Si vous installez la version NSIS, laissez l'installeur créer les raccourcis Bureau et menu Démarrer. Pour un raccourci manuel, utilisez `-TargetPath "$env:LOCALAPPDATA\Programs\FreeRAM\FreeRAM.exe"`.

---

## Licence

FreeRAM est distribué sous licence MIT. Voir le fichier [LICENSE](LICENSE).

---

## Avertissement

FreeRAM ferme des applications à la demande de l'utilisateur. Une fermeture peut entraîner une perte de données non enregistrées. La confirmation le rappelle, mais la responsabilité de sauvegarder le travail reste celle de l'utilisateur. Les processus critiques, les services et FreeRAM lui-même sont protégés, sans garantie absolue contre toute configuration système exotique.
