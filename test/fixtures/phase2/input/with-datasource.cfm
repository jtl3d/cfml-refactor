<cfquery name="getCount" datasource="appdb">
    SELECT COUNT(*) AS cnt FROM users
</cfquery>
