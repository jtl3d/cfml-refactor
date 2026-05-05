<cfquery name="getThings" datasource="appdb">
    SELECT * FROM things WHERE 1 = 1
    <cfif showAll>
        AND visible = 1
    </cfif>
</cfquery>
