<cfquery name="prc.users" datasource="appdb">
    select   id,    name
    from users
    where dept_id  =  <cfqueryparam value="999" cfsqltype="cf_sql_integer">
</cfquery>
