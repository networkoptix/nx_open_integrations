// This project is licensed under the [Mozilla Public License, v. 2.0](http://mozilla.org/MPL/2.0/)

# Authentication Examples (Python) #

## 1. Abstract ##

This sample shows **different ways** to sign in to a **Network Optix** product via
Python APIs.
Each script is self-contained and uses the helper module in
`../common/server_api.py` for low-level HTTP work.

| Script | Method | Typical Use Case| Supported Version | Recommended |
| - | -| - | - | - |
|`local_bearer.py`| Username + password → Session (Token) | On-prem or local systems | 5.1+ | Yes |
|`cloud_bearer.py`| OAuth 2.0 via Cloud | Cloud-Connected Systems | 5.1+ | Yes |
|`local_digest.py`| HTTP Digest on the REST API | Legacy or quick queries| 3.0+ | No |
|`url_digest.py`  | Credentials embedded in URL | Public endpoints or simple pulls | 3.0+ | No |

---

## 2. Prerequisites ##

* Python 3.8+
* `requests` library

> **Note:** All requests use **HTTPS**. Set `verify=False` if you use self-signed certs.

---

## 3. Quick Start ##

1. Open the script that matches your environment.

2. Fill in your server or cloud host URL, credentials, and any IDs (e.g., `CLOUD_SYSTEM_ID`).

3. Run it. For example:

   ```bash
   python cloud_bearer.py
   ```

4. The script prints data (users, system info) to confirm login, then closes the session.

---

## 4. Choosing a Scheme ##

* **OAuth 2.0 (cloud)** – For Nx Cloud, multi-tenant setups, or system + CDB tokens.
* **Bearer token (local)** – Preferred beyond trivial tests; supports fine-grained
  permissions and expiry.
* **HTTP Digest** – Legacy but useful for small tools or health checks. (Deprecated in
  6.1.)
* **URL Digest** – Convenient for embedded scripts or dashboards (use with caution).

---

## 5. Authors ##

**[Network Optix](https://www.networkoptix.com)**
