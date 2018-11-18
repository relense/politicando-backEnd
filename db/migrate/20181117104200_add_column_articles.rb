class AddColumnArticles < ActiveRecord::Migration[5.2]
  def change
    add_column :articles, :tags, :string
  end
end
