const chunk = require("lodash.chunk");
const axios = require("axios");

const getTableRecords = async ({ apiKey, baseId, tableId, params = {} }) => {
  const res = await axios
    .get(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
      params: {
        ...params,
        pageSize: 100,
      },
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    })
    .then((res) => ({
      offset: res.data.offset,
      data: res.data.records.map((v) => ({
        ...v.fields,
        id: v.id,
      })),
    }))
    .catch((e) => console.error(e.response.data.error, e.response.config));
  if (!res) {
    return [];
  }
  return res.offset
    ? [
        ...res.data,
        ...(await getTableRecords({
          apiKey,
          baseId,
          tableId,
          params: {
            ...params,
            offset: res.offset,
          },
        })),
      ]
    : res.data;
};

const insertTableRecords = async ({ apiKey, baseId, tableId, records }) => {
  return Promise.all(
    chunk(records, 10).map((data) =>
      axios
        .post(
          `https://api.airtable.com/v0/${baseId}/${tableId}`,
          { records: data, typecast: true },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
          }
        )
        .then(() =>
          console.log(`insert ${baseId}/${tableId} ${data.length} items`)
        )
        .catch((e) => console.error(e.response.data.error, e.response.config))
    )
  );
};

const updateTableRecords = async ({ apiKey, baseId, tableId, records }) => {
  return Promise.all(
    chunk(records, 10).map((data) =>
      axios
        .put(
          `https://api.airtable.com/v0/${baseId}/${tableId}`,
          { records: data, typecast: true },
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
          }
        )
        .then(() =>
          console.log(`update ${baseId}/${tableId} ${data.length} items`)
        )
        .catch((e) => console.error(e.response.data.error, e.response.config))
    )
  );
};

const deleteTableRecords = async ({ apiKey, baseId, tableId, ids }) => {
  return Promise.all(
    chunk(ids, 10).map((records) =>
      axios
        .delete(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
          params: { records },
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
        })
        .then(() =>
          console.log(`delete ${baseId}/${tableId} ${records.length} items`)
        )
        .catch((e) => console.error(e.response.data.error, e.response.config))
    )
  );
};

module.exports = {
  getTableRecords,
  insertTableRecords,
  updateTableRecords,
  deleteTableRecords,
};
