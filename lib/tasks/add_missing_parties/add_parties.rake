namespace :add_missing_parties do
    task add_parties: :environment do
        Partido.create(
            party_name: "PCTP", 
            description: "Partido Comunista dos Trabalhadores Portugueses",
            deputies_republic_chamber: 0, 
            deputies_acores_legislative_chamber: 0, 
            deputies_madeira_legislative_chamber: 0,
            member_europen_parlament: 0, 
            president_town_hall: 0, 
            councilmen_municipal: 0
        )

        Partido.create(
            party_name: "POUS",
            description: "Partido Operário de Unidade Socialista",
            deputies_republic_chamber: 0,
            deputies_acores_legislative_chamber: 0,
            deputies_madeira_legislative_chamber: 0,
            member_europen_parlament: 0,
            president_town_hall: 0,
            councilmen_municipal: 0
        )

        Partido.create(
            party_name: "PNR",
            description: "Partido Nacional Renovador",
            deputies_republic_chamber: 0,
            deputies_acores_legislative_chamber: 0,
            deputies_madeira_legislative_chamber: 0,
            member_europen_parlament: 0,
            president_town_hall: 0,
            councilmen_municipal: 0
        )

        Partido.create(
            party_name: "PLD",
            description: "Partido Liberal Democrata",
            deputies_republic_chamber: 0,
            deputies_acores_legislative_chamber: 0,
            deputies_madeira_legislative_chamber: 0,
            member_europen_parlament: 0,
            president_town_hall: 0,
            councilmen_municipal: 0
        )

        Partido.create(
            party_name: "PPV",
            description: "Partido Cidadania e Democracia Cristã	",
            deputies_republic_chamber: 0,
            deputies_acores_legislative_chamber: 0,
            deputies_madeira_legislative_chamber: 0,
            member_europen_parlament: 0,
            president_town_hall: 0,
            councilmen_municipal: 0
        )

        Partido.create(
            party_name: "MAS",
            description: "Movimento Alternativa Socialista",
            deputies_republic_chamber: 0,
            deputies_acores_legislative_chamber: 0,
            deputies_madeira_legislative_chamber: 0,
            member_europen_parlament: 0,
            president_town_hall: 0,
            councilmen_municipal: 0
        )

        Partido.create(
            party_name: "PURP",
            description: "Partido Unido dos Reformados e Pensionistas",
            deputies_republic_chamber: 0,
            deputies_acores_legislative_chamber: 0,
            deputies_madeira_legislative_chamber: 0,
            member_europen_parlament: 0,
            president_town_hall: 0,
            councilmen_municipal: 0
        )

        Partido.create(
            party_name: "IL",
            description: "Iniciativa Liberal",
            deputies_republic_chamber: 0,
            deputies_acores_legislative_chamber: 0,
            deputies_madeira_legislative_chamber: 0,
            member_europen_parlament: 0,
            president_town_hall: 0,
            councilmen_municipal: 0
        )

        Partido.create(
            party_name: "A",
            description: "Aliança",
            deputies_republic_chamber: 0,
            deputies_acores_legislative_chamber: 0,
            deputies_madeira_legislative_chamber: 0,
            member_europen_parlament: 0,
            president_town_hall: 0,
            councilmen_municipal: 0
        )

    end
end