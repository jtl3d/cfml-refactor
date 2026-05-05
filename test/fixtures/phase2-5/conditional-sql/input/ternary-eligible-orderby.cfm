<cfquery name="getUsers" datasource="appdb">
    SELECT * FROM users
    WHERE active = 1
    <cfif sortDesc>
        ORDER BY name DESC
    <cfelse>
        ORDER BY name ASC
    </cfif>
</cfquery>
