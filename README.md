<p align="center">
  <img src="https://raw.githubusercontent.com/gablilli/chemediaho/main/frontend/icons/icon-192.png" width="120" alt="che media ho? logo">
</p>

<h1 align="center">📊 che media ho?</h1>

<p align="center">
  <b>la web app self-hostabile per calcolare la media dei voti su classeviva</b><br>
  anche quando l'istituto ha disattivato la funzione ufficiale.
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/gablilli/chemediaho?style=flat-square">
  <img src="https://img.shields.io/github/license/gablilli/chemediaho?style=flat-square">
  <img src="https://img.shields.io/github/actions/workflow/status/gablilli/chemediaho/release.yml?style=flat-square">
  <img src="https://img.shields.io/docker/pulls/gablilli/chemediaho?style=flat-square">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/pwa-ready-blue?style=flat-square">
  <img src="https://img.shields.io/badge/offline-supported-success?style=flat-square">
  <img src="https://img.shields.io/badge/100%25-open--source-green?style=flat-square">
</p>

---

## 🧠 cos'è *che media ho?*

**che media ho?** è una semplice **web app flask**, self-hostabile via **docker**, che ti permette di:

- visualizzare la **media dei voti su classeviva**
- fare **simulazioni e previsioni**
- usare l'app anche **offline**
- installarla come **pwa** su smartphone

il tutto tramite una **ui chiara**, pulita e mobile-friendly.

---

## ✨ funzionalità

- 📱 **pwa (progressive web app)** — installabile su android e ios  
- 🔄 **supporto offline** — funziona anche senza connessione (con dati già scaricati)  
- 🎨 **design responsive** — perfetto su mobile e desktop  
- 📊 **calcolo automatico della media**  
- 🎯 **calcoli & previsioni** — scopri che voti ti servono per raggiungere un obiettivo  
- 📈 **grafici interattivi** — visualizza l'andamento nel tempo  
- 💾 **esportazione csv** — porta i tuoi voti dove vuoi  
- 🆓 **100% free & open source** — con controlli codeql  

---

## 🎛️ modalità di utilizzo

l'app supporta **due modalità**:

### 1️⃣ docker all-in-one (consigliata)

tutto in un unico container: frontend + api.

- ✅ semplice da configurare
- ✅ ideale per uso locale/domestico
- ✅ basta un `docker compose up`

### 2️⃣ vercel + api esterna (avanzata)

frontend su vercel, backend in modalità proxy verso API esterna (es. open-viva/api).

- ✅ frontend accessibile ovunque
- ✅ backend leggero: inoltra solo richieste all'endpoint configurato
- ✅ compatibile con API esterne REST

---

## 1 - 🐳 installazione con docker (consigliata)

modalità **all-in-one**: frontend + api nello stesso container.

### prerequisiti

* docker & docker compose
  👉 [https://docs.docker.com/engine/install/](https://docs.docker.com/engine/install/)

### scarica il `docker-compose.yml`

```bash
curl -fsSL https://raw.githubusercontent.com/gablilli/chemediaho/refs/heads/main/docker-compose.yml -o docker-compose.yml
```

### avvia il container

```bash
docker compose up -d
```

l'app sarà disponibile su **porta 8001**.
apri 👉 **[http://localhost:8001](http://localhost:8001)**

## 2 - 🌐 vercel + api esterna

per utenti avanzati: frontend su vercel, backend in proxy verso API esterna.

### perché questa modalità?

- separi frontend e backend
- quando `STANDALONE_MODE=false` l'app **non usa l'API interna**
- tutte le chiamate vengono inoltrate all'endpoint `API_BASE`

### setup

#### 1. avvia il backend proxy

```bash
STANDALONE_MODE=false API_BASE=https://tuo-endpoint-open-viva-api API_KEY=tua-chiave-segreta python app.py
```

> [!NOTE]
> L'```API_KEY``` non è obbligatoria, ma consigliata.
> Imposta sempre `API_BASE` a un endpoint valido dell'API esterna REST.

#### 2. deploya su vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fgablilli%2Fchemediaho%2Ftree%2Fmain%2Ffrontend&env=API_BASE,API_KEY&project-name=mychemediaho&repository-name=mychemediaho)

---

## 🔑 chiave segreta e sessioni

* generata automaticamente al primo avvio (`secret_key.txt`)
* permessi **600**
* persistita via volume docker

⚠️ **sicurezza**

* proteggi l'accesso al file
* in produzione usa `secret_key` o secret manager
* supporto a **docker secrets** incluso

esempio:

```yaml
    environment:
      - SECRET_KEY_FILE=/run/secrets/flask_secret
    secrets:
      - flask_secret

secrets:
  flask_secret:
    external: true
```

---

## 🛠️ risoluzione problemi

### 401 dopo login (cross-origin)

se usi vercel + api esterna e ricevi 401 dopo il login:

1. verifica che `API_BASE` punti all'endpoint corretto
2. verifica che eventuale `API_KEY` sia la stessa lato frontend/backend
3. controlla che l'API esterna esponga le route REST attese

### controlla i log

```bash
docker logs chemediaho
```

### altri problemi

* verifica credenziali classeviva
* assicurati che la porta 8001 sia aperta
* apri una issue

---

## ❤️ ringraziamenti

grazie a:

* [classeviva official endpoints](https://github.com/lioydiano/classeviva-official-endpoints)
* sysregister di [syswhite.dev](https://github.com/syswhitedev)
* [cvvsimpleavgrage](https://github.com/lucacraft89/cvvsimpleavgrage)

per aver reso possibile tutto questo.

---

<p align="center">
  <b>📚 studia meno i calcoli, pensa più ai voti.</b>
</p>
