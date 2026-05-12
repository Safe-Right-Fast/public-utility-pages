/**
   * REUSABLE QUICKBASE REST TOOLSET
   * Class: SrfQbRest
   * Namespace: window.srfQbRest (instance)
*/
class SrfQbRest {
  #tokenCache = {}; // Stores { dbid: { token, expires } }

  /**
   * @param {object} [options] - Configuration for the SrfQbRest instance.
   * @param {string} [options.realm] - The Quickbase realm (e.g., "mycompany.quickbase.com"). Defaults to the current hostname.
   * @param {string} [options.userAgent] - The User-Agent string to use for requests.
   * @param {string} [options.appToken] - The Quickbase application token. Can be overridden in method calls.
   * @param {boolean} [options.logging=false] - Whether to enable console logging.
   */
  constructor({ realm, userAgent, appToken, logging = false } = {}) {
    this.realm = realm ?? window.location.hostname.replace(".ui", "");
    this.userAgent = userAgent ?? window.srfUserAgent ?? "SrfQbRest";
    this.appToken = appToken;
    this.logging = logging;
  }

  /**
   * Retrieves a temporary authentication token from Quickbase.
   * @param {string} dbid - The DBID of the Quickbase table.
   * @param {string} [apptoken] - An optional app token to override the one set in the constructor.
   * @returns {Promise<string>} A promise that resolves to the temporary authorization token.
   */
  async getAuthToken(dbid, apptoken) {
    const appTokenToUse = apptoken ?? this.appToken;
    if (!appTokenToUse) {
      throw new Error("An appToken must be provided either during SrfQbRest instantiation or to the method call.");
    }

    const now = Date.now();
    const buffer = 2 * 60 * 1000; // 2 minutes in ms

    // Check cache validity
    if (this.#tokenCache[dbid]) {
      const { token, expires } = this.#tokenCache[dbid];
      if (expires - buffer > now) {
        if (this.logging) console.log(`[SrfQbRest] Using cached token for ${dbid}. Expires in: ${Math.round((expires - now) / 1000)}s`);
        return token;
      }
    }

    if (this.logging) console.log(`[SrfQbRest] Fetching fresh token for ${dbid}...`);
    const response = await fetch(
      `https://api.quickbase.com/v1/auth/temporary/${dbid}`,
      {
        method: "GET",
        credentials: "include",
        headers: {
          ...this.createQBHeaders(),
          "QB-App-Token": appTokenToUse,
        },
      }
    );

    if (!response.ok) throw new Error(`Failed to get auth token: ${response.statusText}`);

    const data = await response.json();

    // Cache the new token and its expiration date
    this.#tokenCache[dbid] = {
      token: data.temporaryAuthorization,
      expires: 5 * 60 * 1000 + Date.now(), // 5 Minutes in the future in ms
    };

    return data.temporaryAuthorization;
  }

  /**
   * Creates the standard Quickbase request headers.
   * @param {string} [authToken] - An optional temporary auth token.
   * @returns {object} The headers object.
   */
  createQBHeaders(authToken) {
    const headers = {
      "QB-Realm-Hostname": this.realm,
      "User-Agent": this.userAgent,
    };
    if (authToken) {
      headers.Authorization = `QB-TEMP-TOKEN ${authToken}`;
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  async #handleResponse(response) {
    if (response.ok) {
      return response.json();
    }
    const errorData = await response.json();
    throw new Error(`Quickbase API Error: ${errorData.message} - ${errorData.description}`);
  }

  /**
   * Performs a query against the Quickbase API. By default, this method handles pagination and returns all records.
   * If pagination options (skip or top) are provided, it will return a single page of results.
   * @param {object} params - The query parameters.
   * @param {string} params.from - The DBID of the table to query.
   * @param {number[]} [params.select] - An array of field IDs to be returned.
   * @param {string} [params.where] - The query string to filter records.
   * @param {object[]} [params.sortBy] - An array of objects to sort the records.
   * @param {number} params.sortBy.fieldId - The ID of the field to sort by.
   * @param {'ASC'|'DESC'} [params.sortBy.order='ASC'] - The sort order.
   * @param {object[]} [params.groupBy] - An array of objects to group the records.
   * @param {number} params.groupBy.fieldId - The ID of the field to group by.
   * @param {string} params.groupBy.grouping - The grouping method (e.g., 'equal-values').
   * @param {object} [params.options] - An options object.
   * @param {number} [params.options.skip] - The number of records to skip for pagination. If provided, the query will not be paginated automatically.
   * @param {number} [params.options.top] - The maximum number of records to return. If provided, the query will not be paginated automatically.
   * @param {boolean} [params.options.compareWithAppLocalTime=false] - Use the app's time zone for date/time comparisons.
   * @param {string} [apptoken] - An optional app token to override the one set in the constructor.
   * @returns {Promise<object[]|object>} A promise that resolves to an array of all records, or a single page response object if pagination options are provided.
   */
  async query(params, apptoken) {
    const hasPagination = params.options?.skip !== undefined || params.options?.top !== undefined;

    const singleQuery = async (p, tok) => {
      const authToken = await this.getAuthToken(p.from, tok);
      const response = await fetch("https://api.quickbase.com/v1/records/query", {
        method: "POST",
        headers: this.createQBHeaders(authToken),
        body: JSON.stringify(p),
      });
      return this.#handleResponse(response);
    }

    if (hasPagination) {
      return singleQuery(params, apptoken);
    }

    let allData = [];
    let skip = 0;
    let totalRecords = -1;
    let numRecordsInResponse = 0;

    do {
      const pageParams = { ...params, options: { ...(params.options || {}), skip } };
      const response = await singleQuery(pageParams, apptoken);
      
      if (response.data) {
        allData = allData.concat(response.data);
      }

      if (totalRecords === -1) {
        totalRecords = response.metadata.totalRecords;
      }
      
      numRecordsInResponse = response.metadata.numRecords;
      if (numRecordsInResponse > 0) {
        skip += numRecordsInResponse;
      }
    } while (allData.length < totalRecords && numRecordsInResponse > 0);
    return allData;
  }

  /**
   * Creates or updates records in Quickbase.
   * @param {object} params - The upsert parameters.
   * @param {string} params.to - The DBID of the table to add or update records in.
   * @param {object[]} params.data - The records to create or update. Each record is an object where keys are field IDs and values are objects with a `value` property (e.g., `{ "6": { "value": "some text" } }`).
   * @param {number} [params.mergeFieldId] - The ID of the field to use for merging (updating) records.
   * @param {number[]} [params.fieldsToReturn] - An array of field IDs to be returned after the upsert.
   * @param {string} [apptoken] - An optional app token to override the one set in the constructor.
   * @returns {Promise<object>} A promise that resolves to the JSON response from the API.
   */
  async upsert(params, apptoken) {
    const authToken = await this.getAuthToken(params.to, apptoken);
    const response = await fetch("https://api.quickbase.com/v1/records", {
      method: "POST",
      headers: this.createQBHeaders(authToken),
      body: JSON.stringify(params),
    });
    return this.#handleResponse(response);
  }

  /**
   * Deletes records from Quickbase.
   * @param {object} params - The delete parameters.
   * @param {string} params.from - The DBID of the table to delete from.
   * @param {string} params.where - The query to select records for deletion.
   * @param {string} [apptoken] - An optional app token to override the one set in the constructor.
   * @returns {Promise<object>} A promise that resolves to the JSON response from the API.
   */
  async delete(params, apptoken) {
    const authToken = await this.getAuthToken(params.from, apptoken);
    const response = await fetch("https://api.quickbase.com/v1/records", {
      method: "DELETE",
      headers: this.createQBHeaders(authToken),
      body: JSON.stringify(params),
    });
    return this.#handleResponse(response);
  }

  /**
   * Downloads a file from Quickbase.
   * @param {object} params - The download parameters.
   * @param {string} params.tableId - The DBID of the table.
   * @param {number} params.recordId - The ID of the record.
   * @param {number} params.fieldId - The ID of the file attachment field.
   * @param {number} params.version - The version number of the file.
   * @param {string} [apptoken] - An optional app token to override the one set in the constructor.
   * @returns {Promise<Blob>} A promise that resolves to the file as a Blob.
   */
  async downloadFile({ tableId, recordId, fieldId, version }, apptoken) {
    const authToken = await this.getAuthToken(tableId, apptoken);
    const url = `https://api.quickbase.com/v1/files/${tableId}/${recordId}/${fieldId}/${version}`;
    const response = await fetch(url, {
      method: "GET",
      headers: this.createQBHeaders(authToken),
    });
    if (!response.ok) {
       const errorText = await response.text().catch(() => 'Could not retrieve error details.');
       throw new Error(`File download failed: ${response.statusText} - ${errorText}`);
    }
    
    const contentDisposition = response.headers.get('Content-Disposition');
    let fileName = 'unknown-file'; // Default filename
    if (contentDisposition) {
        // Handles filename*=utf-8''... (RFC 5987)
        let match = contentDisposition.match(/filename\*=utf-8''([^;]+)/i);
        if (match && match[1]) {
            fileName = decodeURIComponent(match[1]);
        } else {
            // Handles filename="..." (legacy)
            match = contentDisposition.match(/filename="([^"]+)"/i);
            if (match && match[1]) {
                fileName = match[1];
            }
        }
    }
    
    // Per documentation, response is base64 encoded. We need to decode it into a blob.
    const base64Data = await response.text();
    const contentType = response.headers.get('Content-Type') || 'application/octet-stream';
    
    const byteCharacters = atob(base64Data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: contentType });

    return { blob, fileName };
  }
}

window.srfQbRest = new SrfQbRest();